/**
 * offload-hooks.ts — LoopPipelineHooks 实现
 *
 * 串联 SwarmOffloadStore + OffloadPipeline + MermaidSynthesizer + MmdInjector，
 * 通过 10 个生命周期 hook 实现完整的 offload 流水线：
 *
 *   afterWorkerRound  → L1  Worker 摘要 → JSONL
 *   afterClonerReview  → L1  Cloner 摘要 → JSONL
 *   afterIteration     → L1.5→L2→L3 流水线 → context-graph.mmd
 *   beforeWorkerRound  → MMD Worker 局部视图注入
 *   beforeClonerReview → MMD Cloner 全局视图注入
 *   beforeIteration    → MMD LoopController 全景视图注入
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
import type { ReviewVerdict } from "../roundtable";
import type { SessionStorage } from "../../session/session-storage";
import type { PlanPhase } from "./plan-node-attributor";
import { getOffloadDir, getMmdsDir } from "./offload-paths";
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
}

// ============================================================================
// createOffloadHooks 工厂
// ============================================================================

/**
 * 创建 offload lifecycle hooks。
 *
 * @param swarmDir  swarm 数据目录
 * @param storage   SessionStorage 实例
 * @param config    Offload 配置
 * @returns         LoopPipelineHooks 实现
 */
export function createOffloadHooks(
	swarmDir: string,
	storage: SessionStorage,
	config: OffloadHooksConfig,
): LoopPipelineHooks {
	const store = new SwarmOffloadStore(swarmDir, storage);
	const pipeline = new OffloadPipeline(config.pipeline);
	const synthesizer = new MermaidSynthesizer(storage);
	const injector = new MmdInjector();

	// 累积的 current MMD 文本
	let currentMmd = "";
	// 最近一次召回结果
	let latestRecall: string | null = null;
	// Worker phase 映射
	const workerPhases = new Map<string, string>();
	// 当前迭代编号（在 beforeIteration 设置，供 afterWorkerRound 等 hook 使用）
	let currentIteration = 0;

	const hooks: LoopPipelineHooks = {
		// -- beforePipeline ------------------------------------------------------

		async beforePipeline(ctx: PipelineContext) {
			if (!config.enabled) return;
			store.offloadDir; // touch — no-op, lazy init on first write
			logger.info("[OffloadHooks] Pipeline started", { swarmDir });
		},

		// -- beforeIteration -----------------------------------------------------

		async beforeIteration(iteration: number, ctx: PipelineContext) {
			currentIteration = iteration;

			if (!config.enabled || !config.injectMermaid) return;

			// 注入 LoopController 全景视图
			if (currentMmd) {
				const view = injector.buildFullView(currentMmd);
				latestRecall = view.injectBlock;
				logger.debug("[OffloadHooks] Injected full MMD view for iteration", { iteration });
			}
		},

		// -- beforeWorkerRound ---------------------------------------------------

		async beforeWorkerRound(round: number, workerIds: string[], ctx: PipelineContext) {
			if (!config.enabled || !config.injectMermaid) return;

			// 构建 Worker 局部视图 — 只看自己负责的 phases
			const phases = workerIds
				.map((id) => workerPhases.get(id))
				.filter((p): p is string => !!p);

			if (currentMmd && phases.length > 0) {
				const view = injector.buildWorkerView(currentMmd, phases);
				latestRecall = view.injectBlock;
				logger.debug("[OffloadHooks] Injected Worker MMD view", {
					round,
					workers: workerIds,
					phases,
				});
			}
		},

		// -- afterWorkerRound ----------------------------------------------------

		async afterWorkerRound(round: number, results: SingleResult[], ctx: PipelineContext) {
			if (!config.enabled) return;

			// 构建 agentId → SingleResult 映射
			const resultMap = new Map<string, SingleResult>();
			for (const r of results) {
				resultMap.set(r.id, r);
			}

			// L1: Worker 产出摘要
			const phaseHints = new Map<string, string>();
			for (const r of results) {
				const hint = config.getPhaseHint?.(r.id);
				if (hint) {
					phaseHints.set(r.id, hint);
					workerPhases.set(r.id, hint);
				}
			}

			const l1Outputs = pipeline.runL1(
				resultMap,
				"worker",
				currentIteration,
				phaseHints,
			);

			// 持久化到 JSONL
			for (const out of l1Outputs) {
				const entry = toOffloadEntry(out);
				await store.appendEntry(out.agentId, entry);
			}
		},

		// -- beforeClonerReview --------------------------------------------------

		async beforeClonerReview(iteration: number, workerOutput: string, ctx: PipelineContext) {
			if (!config.enabled || !config.injectMermaid) return;

			// 注入 Cloner 全局审查视图
			if (currentMmd) {
				const view = injector.buildClonerView(currentMmd);
				latestRecall = view.injectBlock;
				logger.debug("[OffloadHooks] Injected Cloner MMD view", { iteration });
			}
		},

		// -- afterClonerReview ---------------------------------------------------

		async afterClonerReview(iteration: number, verdict: ReviewVerdict | null, ctx: PipelineContext) {
			if (!config.enabled || !verdict) return;

			// Cloner 审查摘要 — 构建虚拟 SingleResult
			const clonerResult: SingleResult = {
				id: "cloner",
				output: [
					`passed: ${verdict.passed}`,
					`approval: ${verdict.approvalCount}/${verdict.totalCount}`,
					...(verdict.findings ?? []).map((f) => `finding: ${f}`),
				].join("\n"),
				exitCode: 0,
				// fallback fields
				agent: "cloner",
				agentSource: "bundled",
				task: "review",
				stderr: "",
				truncated: false,
				durationMs: 0,
				tokens: 0,
				requests: 0,
				index: 0,
			};

			const resultMap = new Map<string, SingleResult>();
			resultMap.set("cloner", clonerResult);

			const scores = new Map<string, number>();
			if (verdict.passed) scores.set("cloner", 8);
			else scores.set("cloner", verdict.approvalCount > 0 ? 4 : 2);

			const l1Outputs = pipeline.runL1(
				resultMap,
				"cloner",
				iteration,
				undefined,
				scores,
			);

			// 持久化
			for (const out of l1Outputs) {
				const entry = toOffloadEntry(out);
				await store.appendEntry(out.agentId, entry);
			}
		},

		// -- afterIteration ------------------------------------------------------

		async afterIteration(iteration: number, ctx: PipelineContext) {
			if (!config.enabled) return;

			// L1.5→L2→L3 流水线
			const phases = config.getPhases?.() ?? [];
			const l2Result = pipeline.forceFlush(phases, iteration);

			if (l2Result && (l2Result.nodes.length > 0 || l2Result.edges.length > 0)) {
				// L3: 合成 MMD
				currentMmd = await synthesizer.synthesize({
					nodes: l2Result.nodes,
					edges: l2Result.edges,
					iteration,
					swarmDir,
					boundaryType: l2Result.boundary.type,
				});

				// 更新 entryNodeMap → JSONL
				for (const [agentId, nodeId] of l2Result.entryNodeMap) {
					// 读取该 agent 的最后一条 entry，更新 node_id
					const entries = await store.readEntries(agentId);
					if (entries.length > 0) {
						const last = entries[entries.length - 1];
						last.node_id = nodeId;
						// 追加更新后的条目（标记原有 phase_id）
						await store.appendEntry(agentId, last);
					}
				}

				logger.info("[OffloadHooks] Iteration complete", {
					iteration,
					nodes: l2Result.nodes.length,
					edges: l2Result.edges.length,
					boundary: l2Result.boundary.type,
				});
			}
		},

		// -- afterPipeline -------------------------------------------------------

		async afterPipeline(status: PipelineResult["status"], ctx: PipelineContext) {
			if (!config.enabled) return;

			// 清理
			pipeline.reset();
			logger.info("[OffloadHooks] Pipeline complete", { status });
		},

		// -- onHookError ---------------------------------------------------------

		onHookError(hookName: string, error: unknown) {
			logger.warn("[OffloadHooks] Hook error", {
				hook: hookName,
				error: String(error),
			});
		},
	};

	return hooks;
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
