/**
 * OffloadAgentHooks — 通用 Agent 生命周期的 Offload 集成
 *
 * 替代 OffloadHooks（LoopPipelineHooks 实现），不再依赖 worker/cloner
 * 执行模型。通过 Agent.onTurnEnd + AgentLoopConfig.transformContext 集成:
 *
 *   Agent.onTurnEnd  →  L1: AgentOffloadSummarizer → JSONL
 *   transformContext  →  MMD 注入 + 经验检索
 *
 * 保留 L1.5 (Deduplicator) + L2 (PlanNodeAttributor) + L3 (MermaidSynthesizer)
 * + MmdInjector 全部不变，仅替换输入端为 AgentMessage[]。
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionStorage } from "../../session/session-storage";
import type { PlanPhase } from "./plan-node-attributor";
import type { ExperienceStore } from "../curtain/experience";
import type { ExtractedLesson } from "../curtain/extractor";
import { getOffloadDir } from "./offload-paths";
import { SwarmOffloadStore } from "./offload-store";
import { OffloadPipeline, type OffloadPipelineConfig } from "./offload-pipeline";
import { MermaidSynthesizer } from "./mermaid-synthesizer";
import { MmdInjector } from "./mmd-injector";
import { AgentOffloadSummarizer, type AgentOffloadEntry } from "./agent-offload-summarizer";

// ============================================================================
// Types
// ============================================================================

export interface OffloadAgentHooksConfig {
	/** 全局启用/禁用 */
	enabled: boolean;
	/** L1+L2 pipeline 配置 */
	pipeline: OffloadPipelineConfig;
	/** 是否在上下文中注入 Mermaid 图 */
	injectMermaid: boolean;
	/** phaseHint 提供器 (agentId → phase 名称) */
	getPhaseHint?: (agentId: string) => string | undefined;
	/** 外部评分提供器 (agentId → score 0-10) */
	getScore?: (agentId: string) => number | undefined;
	/** Plan.md phase 解析器 */
	getPhases?: () => PlanPhase[];
	/** ExperienceStore 实例（可选） */
	experienceStore?: ExperienceStore;
	/** 当前 session 标识 */
	sessionId?: string;
}

export interface OffloadAgentHooksResult {
	/** Agent.onTurnEnd 回调 — 每个 turn 结束后处理消息历史 */
	onTurnEnd: (messages: AgentMessage[]) => Promise<void>;
	/** AgentLoopConfig.transformContext — 在 LLM 调用前注入 MMD + 经验 */
	transformContext: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	/** 获取当前 MMD 上下文注入块（供外部构建 prompt 用） */
	getMmdContext: () => string | null;
	/** 获取指定 agent 最近检索到的经验文本 */
	getExperienceContext: (agentId: string) => string | null;
	/** 强制 flush 所有 pending 条目（iteration 结束时调用） */
	forceFlush: (iteration: number) => Promise<void>;
	/** 重置所有状态（新 session 开始时调用） */
	reset: () => void;
}

// ============================================================================
// createOffloadAgentHooks 工厂
// ============================================================================

export function createOffloadAgentHooks(
	swarmDir: string,
	storage: SessionStorage,
	agentId: string,
	config: OffloadAgentHooksConfig,
): OffloadAgentHooksResult {
	const store = new SwarmOffloadStore(swarmDir, storage);
	const pipeline = new OffloadPipeline(config.pipeline);
	const synthesizer = new MermaidSynthesizer(storage);
	const injector = new MmdInjector();
	const summarizer = new AgentOffloadSummarizer();
	const { experienceStore, sessionId } = config;

	// MMD 状态
	let currentMmd = "";
	let latestMmdInjection: string | null = null;
	// 经验检索缓存
	let latestExperienceContext: string | null = null;
	// Worker phase 记录
	const phaseMap = new Map<string, string>();

	// 当前 turn 计数
	let turnIndex = 0;

	/**
	 * Agent.onTurnEnd 回调:
	 * - L1: 对当前 turn 的 messages 生成摘要
	 * - 写入 JSONL
	 * - 检查是否触发 L1.5→L2→L3 flush
	 */
	async function onTurnEnd(messages: AgentMessage[]): Promise<void> {
		if (!config.enabled) return;

		const phaseHint = config.getPhaseHint?.(agentId);
		const score = config.getScore?.(agentId);

		const entry = summarizer.summarize({
			messages,
			agentId,
			turnIndex,
			phaseHint,
			score,
		});

		// 持久化到 JSONL
		const jsonlEntry = toOffloadJsonlEntry(entry);
		await store.appendEntry(agentId, jsonlEntry);

		// 记录 phase
		if (phaseHint) phaseMap.set(agentId, phaseHint);

		turnIndex++;
		logger.debug("[OffloadAgentHooks] Turn end processed", {
			agentId, turnIndex, summaryLen: entry.summary.length,
		});
	}

	/**
	 * AgentLoopConfig.transformContext:
	 * - 注入 MMD 上下文（如果启用）
	 * - 注入经验检索结果
	 */
	async function transformContext(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
		if (!config.enabled) return messages;

		// MMD 注入
		if (config.injectMermaid && currentMmd) {
			const phaseHints = [phaseMap.get(agentId)].filter((p): p is string => !!p);
			const view = phaseHints.length > 0
				? injector.buildWorkerView(currentMmd, phaseHints)
				: injector.buildFullView(currentMmd);

			latestMmdInjection = view.injectBlock;
		}

		// 经验检索
		if (experienceStore) {
			try {
				const phaseHint = config.getPhaseHint?.(agentId) ?? "";
				const query = `agent:${agentId} ${phaseHint}`;
				const results = experienceStore.search(query, 3);

				if (results.length > 0) {
					latestExperienceContext = formatExperienceForInjection(agentId, results);
				}
			} catch (err) {
				logger.warn("[OffloadAgentHooks] Experience search failed", {
					agentId, error: String(err),
				});
			}
		}

		signal?.throwIfAborted();
		return messages;
	}

	/**
	 * 强制 flush: L1.5→L2→L3
	 */
	async function forceFlush(iteration: number): Promise<void> {
		if (!config.enabled) return;

		// 先将 pending L1 entries 提交到 pipeline
		const allEntries = await store.readAllEntries();
		if (allEntries.length === 0) return;

		const entries: AgentOffloadEntry[] = allEntries.map(e => ({
			agentId: e.agent_id,
			summary: e.summary,
			score: e.score,
			taskCall: e.task_call,
			turnIndex: e.iteration,
			phaseHint: e.phase_id,
			resultRef: e.result_ref,
			timestamp: e.timestamp,
		}));

		pipeline.runL1FromEntries(entries);

		const phases = config.getPhases?.() ?? [];
		const l2Result = pipeline.forceFlush(phases, iteration);

		if (l2Result && (l2Result.nodes.length > 0 || l2Result.edges.length > 0)) {
			currentMmd = await synthesizer.synthesize({
				nodes: l2Result.nodes,
				edges: l2Result.edges,
				iteration,
				swarmDir,
				boundaryType: l2Result.boundary.type,
			});

			logger.info("[OffloadAgentHooks] Flush complete", {
				iteration, nodes: l2Result.nodes.length,
				edges: l2Result.edges.length, boundary: l2Result.boundary.type,
			});
		}
	}

	/** 重置所有状态 */
	function reset(): void {
		pipeline.reset();
		turnIndex = 0;
		currentMmd = "";
		latestMmdInjection = null;
		latestExperienceContext = null;
		phaseMap.clear();
	}

	return {
		onTurnEnd,
		transformContext,
		getMmdContext: () => latestMmdInjection,
		getExperienceContext: () => latestExperienceContext,
		forceFlush,
		reset,
	};
}

// ============================================================================
// Helpers
// ============================================================================

function toOffloadJsonlEntry(entry: AgentOffloadEntry) {
	return {
		timestamp: entry.timestamp,
		agent_type: "worker" as const,
		agent_id: entry.agentId,
		iteration: entry.turnIndex,
		phase_id: entry.phaseHint,
		task_call: entry.taskCall,
		summary: entry.summary,
		score: entry.score,
		result_ref: entry.resultRef,
	};
}

function formatExperienceForInjection(
	agentId: string,
	results: Array<{ runId: string; timestamp: string; lesson: ExtractedLesson; rank: number }>,
): string {
	const lines = [`<agent_experience agent="${agentId}" count="${results.length}">`];

	for (const r of results) {
		const date = r.timestamp.slice(0, 10);
		const typeIcon = r.lesson.type === "success" ? "✔" : r.lesson.type === "error" ? "✗" : "•";
		lines.push(`  <entry type="${r.lesson.type}" confidence="${r.lesson.confidence.toFixed(2)}">`);
		lines.push(`    ${typeIcon} [${date}] ${r.lesson.summary}`);
		if (r.lesson.detail && r.lesson.detail !== r.lesson.summary) {
			lines.push(`    detail: ${r.lesson.detail.slice(0, 200)}`);
		}
		lines.push(`  </entry>`);
	}

	lines.push("</agent_experience>");
	return lines.join("\n");
}
