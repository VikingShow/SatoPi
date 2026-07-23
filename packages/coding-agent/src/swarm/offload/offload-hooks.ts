/**
 * offload-hooks.ts — LoopPipelineHooks 实现
 *
 * 串联 SwarmOffloadStore + OffloadPipeline + MermaidSynthesizer + MmdInjector，
 * 通过 10 个生命周期 hook 实现完整的 offload 流水线：
 *
 *   afterWorkerRound  → L1  Worker 摘要 → JSONL + ♻ ExperienceStore
 *   afterClonerReview  → L1  Cloner 摘要 → JSONL
 *   afterIteration     → L1.5→L2→L3 流水线 → context-graph.mmd
 *   beforeWorkerRound  → MMD Worker 局部视图 + ♻ 历史经验注入
 *   beforeClonerReview → MMD Cloner 全局视图注入
 *   beforeIteration    → MMD LoopController 全景视图注入
 *
 * ♻ = ExperienceStore 桥接 (Phase 6a: Offload ⇄ 经验蒸馏)
 *
 * loop-controller.ts 零修改。通过 runLoop({ hooks: offloadHooks }) 注入。
 */

import { logger } from "@oh-my-pi/pi-utils";
import type {
	LoopPipelineHooks,
	PipelineContext,
	PipelineResult,
	WaveResult,
} from "../pipeline";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent";
import type { ReviewVerdict } from "../review-council";
import type { SessionStorage } from "../../session/session-storage";
import type { PlanPhase } from "./plan-node-attributor";
import type { ExperienceStore } from "../after-loop/experience";
import type { ExtractedLesson, LoopRunStats } from "../after-loop/extractor";
import { getOffloadDir } from "./offload-paths";
import { SwarmOffloadStore } from "./offload-store";
import { OffloadPipeline, type OffloadPipelineConfig } from "./offload-pipeline";
import { MermaidSynthesizer } from "./mermaid-synthesizer";
import { MmdInjector } from "./mmd-injector";

// ============================================================================
// Types
// ============================================================================

export interface OffloadHooksConfig {
	/** 全局启用/禁用 */
	enabled: boolean;
	/** L1+L2 pipeline 配置 */
	pipeline: OffloadPipelineConfig;
	/** 是否在 Worker prompt 中注入 Mermaid 图 */
	injectMermaid: boolean;
	/** phaseHint 提供器 (agentId → phase 名称) */
	getPhaseHint?: (agentId: string) => string | undefined;
	/** Cloner 评分提供器 (agentId → score 0-10) */
	getClonerScore?: (agentId: string) => number | undefined;
	/** Plan.md phase 解析器 — 返回当前 plan 的 phase 列表（供 L2 归因用）。 */
	getPhases?: () => PlanPhase[];
	/**
	 * ExperienceStore 实例（可选）。
	 * 传入后启用 Offload→Experience 桥接：
	 *   - afterIteration: 将 offload 摘要蒸馏为 ExtractedLesson 写入
	 *   - beforeWorkerRound: 检索历史经验注入 Worker prompt
	 */
	experienceStore?: ExperienceStore;
	/** 当前 session 标识（供 runId 生成）。 */
	sessionId?: string;
}

// ============================================================================
// createOffloadHooks 工厂
// ============================================================================

export interface OffloadHooksResult {
	hooks: LoopPipelineHooks;
	/**
	 * 获取最近一次检索到的经验上下文文本。
	 * 调用方可在构建 Worker/Cloner prompt 时将此文本注入。
	 *
	 * 返回格式: "<agent_experience>\n...\n</agent_experience>" 或 null
	 */
	getExperienceContext: (agentId: string) => string | null;
	/**
	 * 获取最近一次生成的 MMD 注入块。
	 * 调用方可在构建 prompt 时将此文本注入。
	 */
	getMmdContext: () => string | null;
}

/**
 * 创建 offload lifecycle hooks。
 *
 * @param swarmDir  swarm 数据目录
 * @param storage   SessionStorage 实例
 * @param config    Offload 配置
 * @returns         hooks + 上下文 getter
 */
export function createOffloadHooks(
	swarmDir: string,
	storage: SessionStorage,
	config: OffloadHooksConfig,
): OffloadHooksResult {
	const store = new SwarmOffloadStore(swarmDir, storage);
	const pipeline = new OffloadPipeline(config.pipeline);
	const synthesizer = new MermaidSynthesizer(storage);
	const injector = new MmdInjector();
	const { experienceStore, sessionId } = config;

	// 累积的 current MMD 文本
	let currentMmd = "";
	// 最近一次 MMD 注入块
	let latestMmdInjection: string | null = null;
	// 最近一次经验检索结果 (agentId → XML 注入块)
	const latestExperienceMap = new Map<string, string>();
	// Worker phase 映射
	const workerPhases = new Map<string, string>();
	// 当前迭代编号
	let currentIteration = 0;

	// ── ExperienceStore 桥接用统计 ──────────────────────────────────────
	let totalWorkerTasks = 0;
	let totalClonerTasks = 0;

	const hooks: LoopPipelineHooks = {
		// -- beforePipeline ------------------------------------------------------

		async beforePipeline(ctx: PipelineContext) {
			if (!config.enabled) return;
			store.offloadDir; // touch — no-op, lazy init on first write

			// 初始化 ExperienceStore (lazy, safe to call multiple times)
			if (experienceStore) {
				try {
					await experienceStore.init();
					logger.info("[OffloadHooks] ExperienceStore bridge enabled", { swarmDir });
				} catch (err) {
					logger.warn("[OffloadHooks] ExperienceStore init failed — bridge disabled", { error: String(err) });
				}
			}

			logger.info("[OffloadHooks] Pipeline started", { swarmDir });
		},

		// -- beforeIteration -----------------------------------------------------

		async beforeIteration(iteration: number, ctx: PipelineContext) {
			currentIteration = iteration;

			if (!config.enabled || !config.injectMermaid) return;

			if (currentMmd) {
				const view = injector.buildFullView(currentMmd);
				latestMmdInjection = view.injectBlock;
				logger.debug("[OffloadHooks] Injected full MMD view for iteration", { iteration });
			}
		},

		// -- beforeWorkerRound ---------------------------------------------------

		async beforeWorkerRound(round: number, agentIds: string[], ctx: PipelineContext) {
			if (!config.enabled) return;

			// ── MMD 局部视图注入 ──────────────────────────────────────────
			if (config.injectMermaid) {
				const phases = agentIds
					.map((id) => workerPhases.get(id))
					.filter((p): p is string => !!p);

				if (currentMmd && phases.length > 0) {
					const view = injector.buildWorkerView(currentMmd, phases);
					latestMmdInjection = view.injectBlock;
				}
			}

			// ── 历史经验注入 (ExperienceStore 桥接) ────────────────────────
			if (experienceStore) {
				for (const agentId of agentIds) {
					try {
						const phaseHint = workerPhases.get(agentId) ?? config.getPhaseHint?.(agentId) ?? "";
						const query = `agent:${agentId} ${phaseHint}`;
						const results = experienceStore.search(query, 3);

						if (results.length > 0) {
							const formatted = formatExperienceForInjection(agentId, results);
							latestExperienceMap.set(agentId, formatted);
							logger.debug("[OffloadHooks] Experience injected for agent", {
								agentId, count: results.length,
							});
						}
					} catch (err) {
						logger.warn("[OffloadHooks] Experience search failed for agent", {
							agentId, error: String(err),
						});
					}
				}
			}
		},

		// -- afterWorkerRound ----------------------------------------------------

		async afterWorkerRound(round: number, results: SingleResult[], ctx: PipelineContext) {
			if (!config.enabled) return;

			const resultMap = new Map<string, SingleResult>();
			for (const r of results) resultMap.set(r.id, r);

			const phaseHints = new Map<string, string>();
			for (const r of results) {
				const hint = config.getPhaseHint?.(r.id);
				if (hint) { phaseHints.set(r.id, hint); workerPhases.set(r.id, hint); }
			}

			const l1Outputs = pipeline.runL1(resultMap, "worker", currentIteration, phaseHints);

			// 持久化到 JSONL
			for (const out of l1Outputs) {
				const entry = toOffloadEntry(out);
				await store.appendEntry(out.agentId, entry);
			}

			totalWorkerTasks += l1Outputs.length;
		},

		// -- beforeClonerReview --------------------------------------------------

		async beforeClonerReview(iteration: number, agentOutput: string, ctx: PipelineContext) {
			if (!config.enabled || !config.injectMermaid) return;

			if (currentMmd) {
				const view = injector.buildClonerView(currentMmd);
				latestMmdInjection = view.injectBlock;
			}
		},

		// -- afterClonerReview ---------------------------------------------------

		async afterClonerReview(iteration: number, verdict: ReviewVerdict | null, ctx: PipelineContext) {
			if (!config.enabled || !verdict) return;

			const clonerResult: SingleResult = {
				id: "cloner", exitCode: 0,
				agent: "cloner", agentSource: "bundled", task: "review",
				output: [
					`passed: ${verdict.passed}`,
					`approval: ${verdict.approvalCount}/${verdict.totalCount}`,
					...(verdict.findings ?? []).map((f) => `finding: ${f}`),
				].join("\n"),
				stderr: "", truncated: false, durationMs: 0,
				tokens: 0, requests: 0, index: 0,
			};

			const resultMap = new Map<string, SingleResult>();
			resultMap.set("cloner", clonerResult);

			const scores = new Map<string, number>();
			scores.set("cloner", verdict.passed ? 8 : verdict.approvalCount > 0 ? 4 : 2);

			const l1Outputs = pipeline.runL1(resultMap, "cloner", iteration, undefined, scores);
			for (const out of l1Outputs) {
				await store.appendEntry(out.agentId, toOffloadEntry(out));
			}

			totalClonerTasks += l1Outputs.length;
		},

		// -- afterIteration ------------------------------------------------------

		async afterIteration(iteration: number, ctx: PipelineContext) {
			if (!config.enabled) return;

			const phases = config.getPhases?.() ?? [];
			const l2Result = pipeline.forceFlush(phases, iteration);

			if (l2Result && (l2Result.nodes.length > 0 || l2Result.edges.length > 0)) {
				currentMmd = await synthesizer.synthesize({
					nodes: l2Result.nodes, edges: l2Result.edges,
					iteration, swarmDir, boundaryType: l2Result.boundary.type,
				});

				for (const [agentId, nodeId] of l2Result.entryNodeMap) {
					const entries = await store.readEntries(agentId);
					if (entries.length > 0) {
						const last = entries[entries.length - 1];
						last.node_id = nodeId;
						await store.appendEntry(agentId, last);
					}
				}

				logger.info("[OffloadHooks] Iteration complete", {
					iteration, nodes: l2Result.nodes.length,
					edges: l2Result.edges.length, boundary: l2Result.boundary.type,
				});
			}

			// ── ExperienceStore 桥接: Offload 摘要 → ExtractedLesson ──────
			if (experienceStore) {
				await bridgeToExperienceStore(store, experienceStore, {
					iteration, sessionId,
					agentCount: workerPhases.size,
					reviewerCount: 1, // Cloner Council 汇总为 1 个逻辑 agent
					taskDescription: phases.map(p => p.title).join(", "),
				});
			}
		},

		// -- afterPipeline -------------------------------------------------------

		async afterPipeline(status: PipelineResult["status"], ctx: PipelineContext) {
			if (!config.enabled) return;

			// ── 最终 ExperienceStore 桥接 (写入各 agent 的 session 级摘要) ──
			if (experienceStore) {
				try {
					await bridgeSessionSummary(store, experienceStore, {
						sessionId, status,
						totalWorkerTasks, totalClonerTasks,
						swarmDir,
					});
					logger.info("[OffloadHooks] Session summary written to ExperienceStore");
				} catch (err) {
					logger.warn("[OffloadHooks] Session summary bridge failed", { error: String(err) });
				}
			}

			pipeline.reset();
			logger.info("[OffloadHooks] Pipeline complete", { status });
		},

		// -- onHookError ---------------------------------------------------------

		onHookError(hookName: string, error: unknown) {
			logger.warn("[OffloadHooks] Hook error", { hook: hookName, error: String(error) });
		},
	};

	return {
		hooks,
		getExperienceContext: (agentId: string) => latestExperienceMap.get(agentId) ?? null,
		getMmdContext: () => latestMmdInjection,
	};
}

// ============================================================================
// Helpers
// ============================================================================

function toOffloadEntry(output: OffloadPipeline.L1Output): {
	timestamp: string;
	agent_type: "worker" | "cloner" | "orchestrator";
	agent_id: string;
	iteration: number;
	phase_id?: string;
	node_id?: string;
	task_call: string;
	summary: string;
	score: number;
	result_ref?: string;
} {
	return {
		timestamp: new Date().toISOString(),
		agent_type: output.agentType,
		agent_id: output.agentId,
		iteration: output.iteration,
		phase_id: output.phaseHint,
		task_call: output.taskCall,
		summary: output.summary,
		score: output.score,
		result_ref: output.resultRef,
	};
}

// ============================================================================
// ExperienceStore Bridge
// ============================================================================

interface BridgeMeta {
	iteration?: number;
	sessionId?: string;
	agentCount: number;
	reviewerCount: number;
	taskDescription?: string;
}

/**
 * 将当前迭代中所有 agent 的 offload 摘要蒸馏为 ExtractedLesson，
 * 写入 ExperienceStore（含去重合并 + FTS 索引）。
 */
async function bridgeToExperienceStore(
	store: SwarmOffloadStore,
	xpStore: ExperienceStore,
	meta: BridgeMeta,
): Promise<void> {
	const sessionId = meta.sessionId ?? "unknown";
	const allEntries = await store.readAllEntries();

	// 按 agentId 分组
	const grouped = new Map<string, typeof allEntries>();
	for (const e of allEntries) {
		const list = grouped.get(e.agent_id) ?? [];
		list.push(e);
		grouped.set(e.agent_id, list);
	}

	let savedCount = 0;
	for (const [agentId, entries] of grouped) {
		if (entries.length === 0) continue;

		const scores = entries.map(e => e.score);
		const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
		const domains = [...new Set(entries.map(e => e.phase_id).filter(Boolean))];
		const combinedSummary = entries.map(e => `[${e.task_call}] ${e.summary}`).join("; ");

		// 确定 lesson type
		let lessonType: ExtractedLesson["type"] = "insight";
		if (avgScore >= 7) lessonType = "success";
		else if (avgScore < 3) lessonType = "error";

		const lesson: ExtractedLesson = {
			type: lessonType,
			summary: `${agentId} avg score ${avgScore.toFixed(1)}/10: ${combinedSummary.slice(0, 180)}`,
			detail: combinedSummary.slice(0, 500),
			tags: ["offload", `agent:${agentId}`, ...domains.map(d => `phase:${d}`)],
			confidence: Math.min(0.9, avgScore / 10),
			source: `offload-bridge:${agentId}`,
		};

		const stats: LoopRunStats = {
			totalIterations: meta.iteration ?? 0,
			finalStatus: avgScore >= 7 ? "completed" : avgScore >= 4 ? "converged_partial" : "converged_failed",
			reviewApprovalRatio: avgScore / 10,
			agentCount: meta.agentCount,
			reviewerCount: meta.reviewerCount,
			taskDescription: meta.taskDescription,
		};

		const runId = `${sessionId}-offload-${agentId}-${meta.iteration ?? "end"}`;
		xpStore.saveLesson({
			runId,
			timestamp: new Date().toISOString(),
			lesson,
			stats,
			weight: 1.0,
		});
		savedCount++;
	}

	if (savedCount > 0) {
		logger.info("[OffloadHooks] Bridge: offload → ExperienceStore", {
			agents: savedCount, entries: allEntries.length,
		});
	}
}

/**
 * Session 结束时写入一个整体摘要。
 */
async function bridgeSessionSummary(
	store: SwarmOffloadStore,
	xpStore: ExperienceStore,
	meta: { sessionId?: string; status: string; totalWorkerTasks: number; totalClonerTasks: number; swarmDir: string },
): Promise<void> {
	const allEntries = await store.readAllEntries();
	if (allEntries.length === 0) return;

	const sessionId = meta.sessionId ?? "unknown";
	const avgScore = allEntries.reduce((s, e) => s + e.score, 0) / allEntries.length;

	const lesson: ExtractedLesson = {
		type: meta.status === "completed" ? "success" : "insight",
		summary: `Swarm session completed (status=${meta.status}): ${allEntries.length} offload entries, ${meta.totalWorkerTasks + meta.totalClonerTasks} tasks, avg score ${avgScore.toFixed(1)}`,
		detail: allEntries.slice(0, 10).map(e => `[${e.agent_type}:${e.agent_id}] ${e.summary}`).join("\n"),
		tags: ["offload", "session-summary", meta.status],
		confidence: 0.8,
		source: "offload-bridge:session",
	};

	const stats: LoopRunStats = {
		totalIterations: 0,
		finalStatus: meta.status as LoopRunStats["finalStatus"],
		reviewApprovalRatio: avgScore / 10,
		agentCount: 0,
		reviewerCount: meta.totalClonerTasks,
		taskDescription: `Offload session: ${meta.swarmDir}`,
	};

	xpStore.saveLesson({
		runId: `${sessionId}-offload-session-summary`,
		timestamp: new Date().toISOString(),
		lesson, stats, weight: 1.5,
	});

	logger.info("[OffloadHooks] Bridge: session summary → ExperienceStore", {
		entries: allEntries.length, avgScore: avgScore.toFixed(1),
	});
}

/**
 * 将 ExperienceStore 检索结果格式化为可注入的经验文本。
 */
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
