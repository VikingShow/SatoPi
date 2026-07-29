/**
 * OffloadPipeline — L1→L1.5→L2 流水线编排器
 *
 * 将 TencentDB-Agent-Memory 的四层 offload pipeline 映射到 SatoPi Swarm 循环：
 *   L1 (AgentSummarizer) → L1.5 (Deduplicator) → L2 (PlanNodeAttributor)
 *
 * L3 (MermaidSynthesizer) 由独立模块 `mermaid-synthesizer.ts` 处理。
 */

import type { SingleResult } from "@satopi/pi-coding-agent";
import { logger } from "@satopi/pi-utils";
import type { ReviewVerdict } from "../../swarm/core/pipeline";
import type { L2MermaidOutput, L2NewEntry, LlmMermaidSynthesizer } from "../mermaid/llm-synthesizer";
import type { AgentOffloadEntry } from "./agent-summarizer";
import { type MmdEdge, type MmdNode, PlanNodeAttributor, type PlanPhase } from "./attributor";
import { type DedupEntry, Deduplicator, type TaskBoundary } from "./deduplicator";
import type { L15Judgment, L15MmdEntry, TaskBoundaryJudge } from "./l15-judge";
import { AgentSummarizer } from "./summarizer";

// ============================================================================
// Types
// ============================================================================

export interface OffloadPipelineConfig {
	/** L1 触发阈值：累积条目数 >= 此值时触发 flush */
	l1TriggerThreshold: number;
	/** L2 触发阈值：phase_id=null 条目 >= 此值时触发 L2 */
	l2NullThreshold: number;
	/** L2 超时（秒）：距上次 L2 >= 此值时强制触发 */
	l2TimeoutSeconds: number;
}

export namespace OffloadPipeline {
	export interface L1Output {
		agentId: string;
		summary: string;
		score: number;
		taskCall: string;
		iteration: number;
		phaseHint?: string;
		resultRef?: string;
	}

	export interface L2Output {
		nodes: MmdNode[];
		edges: MmdEdge[];
		entryNodeMap: Map<string, string>;
		boundary: TaskBoundary;
	}
}

// ============================================================================
// OffloadPipeline
// ============================================================================

export class OffloadPipeline {
	readonly #config: OffloadPipelineConfig;
	readonly #summarizer = new AgentSummarizer();
	readonly #deduplicator = new Deduplicator();
	readonly #attributor = new PlanNodeAttributor();
	readonly #taskJudge?: TaskBoundaryJudge;
	readonly #llmMermaid?: LlmMermaidSynthesizer;

	/** L1 累积的待处理条目 */
	#pendingL1: OffloadPipeline.L1Output[] = [];

	/** 上一轮 L1.5 已处理的条目 */
	#prevDeduped: DedupEntry[] = [];

	/** 上次 L2 执行时间 */
	#lastL2Time = 0;

	constructor(
		config: OffloadPipelineConfig,
		opts?: {
			taskJudge?: TaskBoundaryJudge;
			llmMermaid?: LlmMermaidSynthesizer;
		},
	) {
		this.#config = config;
		this.#taskJudge = opts?.taskJudge;
		this.#llmMermaid = opts?.llmMermaid;
	}

	// -- L1: Worker/Cloner 产出摘要 ------------------------------------------

	/**
	 * 处理单个 Wave 的 Agent 产出。
	 *
	 * @param results    Wave 产出结果
	 * @param iteration  当前迭代编号
	 * @param phaseHints agentId → phase 名称映射（可选）
	 * @param scores     agentId → 评分映射（可选）
	 */
	async runL1(
		results: Map<string, SingleResult>,
		iteration: number,
		phaseHints?: Map<string, string>,
		scores?: Map<string, number>,
	): Promise<OffloadPipeline.L1Output[]> {
		const outputs: OffloadPipeline.L1Output[] = [];

		for (const [agentId, result] of results) {
			const phaseHint = phaseHints?.get(agentId);
			const score = scores?.get(agentId);

			const summ = await this.#summarizer.summarize({
				result,
				agentId,
				iteration,
				phaseHint,
				score,
			});

			outputs.push({
				agentId,
				summary: summ.summary,
				score: summ.score,
				taskCall: summ.taskCall,
				iteration,
				phaseHint,
				resultRef: summ.resultRef,
			});
		}

		this.#pendingL1.push(...outputs);
		logger.debug("[OffloadPipeline] L1 complete", {
			iteration,
			outputs: outputs.length,
			pendingTotal: this.#pendingL1.length,
		});

		return outputs;
	}

	/**
	 * 接收通用 AgentOffloadEntry[]（不依赖 worker/cloner 执行模型）。
	 * 用于重构后的 OffloadAgentHooks 集成路径。
	 */
	runL1FromEntries(entries: AgentOffloadEntry[]): OffloadPipeline.L1Output[] {
		const outputs: OffloadPipeline.L1Output[] = entries.map(e => ({
			agentId: e.agentId,
			summary: e.summary,
			score: e.score,
			taskCall: e.taskCall,
			iteration: e.turnIndex,
			phaseHint: e.phaseHint,
			resultRef: e.resultRef,
		}));

		this.#pendingL1.push(...outputs);
		logger.debug("[OffloadPipeline] L1 (generic) complete", {
			entries: entries.length,
			pendingTotal: this.#pendingL1.length,
		});

		return outputs;
	}

	/**
	 * 检查是否应触发 L1.5→L2 flush。
	 * 条件：pending 条目 >= l1TriggerThreshold
	 */
	shouldFlushL2(): boolean {
		return this.#pendingL1.length >= this.#config.l1TriggerThreshold;
	}

	// -- L1.5 + L2: 去重 + 归因 ----------------------------------------------

	/**
	 * 执行 L1.5（去重）+ L2（归因）流水线。
	 *
	 * @param phases 当前 plan.md 解析出的 phase 列表
	 * @param iteration 当前迭代编号
	 * @param verdict   Cloner 审查结果（用于边界检测）
	 */
	runL2(phases: PlanPhase[], iteration: number, verdict?: ReviewVerdict): OffloadPipeline.L2Output | null {
		if (this.#pendingL1.length === 0) return null;

		// L1.5: 去重 + 边界检测
		const dedupInput: DedupEntry[] = this.#pendingL1.map(e => ({
			agentId: e.agentId,
			summary: e.summary,
			score: e.score,
			iteration: e.iteration,
		}));

		const dedupResult = this.#deduplicator.deduplicate({
			entries: dedupInput,
			prevEntries: this.#prevDeduped,
			verdict,
		});

		// 更新累积状态
		this.#prevDeduped = dedupResult.kept;

		// L2: 归因
		const keptEntries: OffloadPipeline.L1Output[] = [];
		const keptAgentIds = new Set(dedupResult.kept.map(k => k.agentId));
		for (const e of this.#pendingL1) {
			if (keptAgentIds.has(e.agentId)) {
				keptEntries.push(e);
			}
		}

		const attrResult = this.#attributor.attribute({
			entries: keptEntries.map(e => ({
				agentId: e.agentId,
				summary: e.summary,
				score: e.score,
				iteration: e.iteration,
				phaseHint: e.phaseHint,
			})),
			phases,
			iteration,
		});

		// 清空 pending
		this.#pendingL1 = [];
		this.#lastL2Time = Date.now();

		logger.info("[OffloadPipeline] L1.5+L2 complete", {
			iteration,
			nodes: attrResult.nodes.length,
			edges: attrResult.edges.length,
			boundary: dedupResult.boundary.type,
			removed: dedupResult.removed.length,
		});

		return {
			nodes: attrResult.nodes,
			edges: attrResult.edges,
			entryNodeMap: attrResult.entryNodeMap,
			boundary: dedupResult.boundary,
		};
	}

	// -- Flush remaining (迭代结束时调用) --------------------------------------

	/**
	 * 强制 flush 所有 pending 条目（迭代结束时调用）。
	 */
	forceFlush(phases: PlanPhase[], iteration: number, verdict?: ReviewVerdict): OffloadPipeline.L2Output | null {
		return this.runL2(phases, iteration, verdict);
	}

	/**
	 * 重置 L1.5 跨迭代状态（新 session 开始时调用）。
	 */
	reset(): void {
		this.#pendingL1 = [];
		this.#prevDeduped = [];
		this.#lastL2Time = 0;
		this.#attributor.reset();
	}

	// -- LLM-powered L1.5 + L2 (optional) -----------------------------------

	/**
	 * LLM-powered task boundary judgment (L1.5).
	 * Returns null if no LLM judge configured.
	 */
	async runL15Llm(input: {
		recentMessages: string;
		currentMmd: string | null;
		availableMmds: L15MmdEntry[];
	}): Promise<L15Judgment | null> {
		if (!this.#taskJudge) return null;
		return this.#taskJudge.judge(input);
	}

	/**
	 * LLM-powered Mermaid graph synthesis (L2).
	 * Returns null if no LLM synthesizer configured.
	 */
	async runL2Llm(input: {
		existingMmd: string | null;
		entries: L2NewEntry[];
		taskLabel: string;
	}): Promise<L2MermaidOutput | null> {
		if (!this.#llmMermaid) return null;
		return this.#llmMermaid.synthesize(input);
	}

	// -- Getters ---------------------------------------------------------------

	get pendingCount(): number {
		return this.#pendingL1.length;
	}

	get secondsSinceLastL2(): number {
		if (this.#lastL2Time === 0) return Infinity;
		return (Date.now() - this.#lastL2Time) / 1000;
	}

	/**
	 * 是否需要因超时而触发 L2。
	 */
	isL2Timeout(): boolean {
		if (this.#pendingL1.length === 0) return false;
		return this.secondsSinceLastL2 >= this.#config.l2TimeoutSeconds;
	}
}
