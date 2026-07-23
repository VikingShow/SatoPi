/**
 * swarm-hooks.ts — AgentProfile + Stigmergy 生命周期 Hook
 *
 * 遵循 offload-hooks.ts 的工厂模式：
 *   createSwarmHooks() → { hooks: LoopPipelineHooks, context: ContextGetters }
 *
 * 设计原则：
 * 1. loop-controller.ts 零逻辑修改（仅 LoopOptions 接口增加 getAgentContext 可选回调）
 * 2. ProfileRegistry + MarkEnvironment 通过 SharedServices 注入
 * 3. Hook 失败不崩溃 pipeline — 统一走 onHookError 日志
 *
 * 生命周期：
 *   beforePipeline      → 注册所有 Agent 的 Profile（幂等）
 *   beforeWorkerRound   → 可跳过
 *   afterWorkerRound    → 记录任务完成 + 更新信用分 + 放置 artifact Mark
 *   afterClonerReview   → 记录 praise/criticism → 更新信用分
 *   onHookError         → 日志
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { LoopPipelineHooks, PipelineContext } from "../pipeline";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent";
import type { ReviewVerdict } from "../roundtable";
import type { ProfileRegistry } from "./agent-profile";
import type { MarkEnvironment } from "./mark-environment";

// ============================================================================
// Types
// ============================================================================

export interface SwarmHooksConfig {
	enabled: boolean;
	profileRegistry: ProfileRegistry;
	markEnvironment: MarkEnvironment;
}

/**
 * Context getters — 供调用方在构建 Worker prompt 时注入。
 */
export interface ContextGetters {
	/**
	 * 获取指定 Agent 的完整上下文注入文本。
	 * 包含：Profile XML 块 + Mark 环境信号 + 信用排名。
	 *
	 * 调用方应在每个 Round 前调用此方法，将结果注入 Worker prompt。
	 */
	getAgentContext(agentId: string): string | null;

	/**
	 * 获取 Swarm 级信用排名摘要。
	 */
	getSwarmCreditSummary(): string;
}

export interface SwarmHooksResult {
	hooks: LoopPipelineHooks;
	context: ContextGetters;
}

// ============================================================================
// Factory
// ============================================================================

export function createSwarmHooks(config: SwarmHooksConfig): SwarmHooksResult {
	const { profileRegistry, markEnvironment } = config;

	// 已注册 Profile 的 Agent ID 集合
	const registeredProfiles = new Set<string>();
	/** 所有已知的 Agent ID（用于信用排名） */
	let allAgentIds: string[] = [];

	const context: ContextGetters = {
		getAgentContext(agentId: string): string | null {
			const parts: string[] = [];

			const profileCtx = profileRegistry.getPromptContext(agentId);
			if (profileCtx) parts.push(profileCtx);

			const markCtx = markEnvironment.getContextForAgent(agentId);
			if (markCtx) parts.push(markCtx);

			return parts.length > 0 ? parts.join("\n") : null;
		},

		getSwarmCreditSummary(): string {
			return profileRegistry.getSwarmCreditSummary(allAgentIds);
		},
	};

	const hooks: LoopPipelineHooks = {
		// ── beforePipeline ────────────────────────────────────────

		async beforePipeline(_ctx: PipelineContext) {
			if (!config.enabled) return;
			logger.info("[SwarmHooks] Pipeline started — profiles registered", {
				count: registeredProfiles.size,
			});
		},

		// ── beforeWorkerRound ─────────────────────────────────────

		async beforeWorkerRound(round: number, workerIds: string[], _ctx: PipelineContext) {
			if (!config.enabled) return;

			// 确保所有 Worker 都有 Profile（幂等注册）
			for (const id of workerIds) {
				if (!registeredProfiles.has(id)) {
					profileRegistry.getOrCreate({
						profileId: id,
						name: id,
						archetype: "worker",
						description: `Loop Engineering Worker`,
					});
					registeredProfiles.add(id);
				}
			}

			// 更新全局 Agent ID 列表
			allAgentIds = [...new Set([...allAgentIds, ...workerIds])];

			// 记录协作关系
			profileRegistry.recordCollaboration(workerIds);

			// 为每个 Worker 放置 start-round Mark
			for (const id of workerIds) {
				markEnvironment.placeMark({
					markId: `worker-${id}-round-${round}-${Date.now()}`,
					type: "signal",
					agentId: id,
					message: `Worker ${id} started round ${round}`,
					priority: "low",
					ttlMs: 10 * 60 * 1000, // 10 min
				});
			}

			logger.debug("[SwarmHooks] Worker round started", { round, workers: workerIds.length });
		},

		// ── afterWorkerRound ──────────────────────────────────────

		async afterWorkerRound(round: number, results: SingleResult[], _ctx: PipelineContext) {
			if (!config.enabled) return;

			for (const result of results) {
				const profile = profileRegistry.get(result.id);
				if (!profile) continue;

				// 记录任务完成：exitCode 0 = 成功
				const success = result.exitCode === 0;
				profileRegistry.recordTaskCompleted(result.id, success);

				// 放置 artifact Mark（Worker 产出物）
				if (result.output) {
					markEnvironment.placeMark({
						markId: `artifact-${result.id}-round-${round}-${Date.now()}`,
						type: "artifact",
						agentId: result.id,
						message: `Worker ${result.id} completed round ${round}: ${result.output.slice(0, 200)}`,
						priority: "medium",
						ttlMs: 30 * 60 * 1000, // 30 min
						tags: ["worker-output", `round-${round}`],
					});
				}
			}
		},

		// ── beforeClonerReview ────────────────────────────────────

		async beforeClonerReview(_iteration: number, _workerOutput: string, _ctx: PipelineContext) {
			if (!config.enabled) return;
			// no-op for now — cloner profiles registered on next cloner run
		},

		// ── afterClonerReview ─────────────────────────────────────

		async afterClonerReview(iteration: number, verdict: ReviewVerdict | null, _ctx: PipelineContext) {
			if (!config.enabled || !verdict) return;

			// 记录 praise/criticism 到 Profile 信用分
			if (verdict.findings && verdict.findings.length > 0) {
				const praised = extractPraisedAgents(verdict.findings);
				const criticized = extractCriticizedAgents(verdict.findings);
				const allIds = [...new Set([...praised, ...criticized])];

				if (allIds.length > 0) {
					profileRegistry.recordReviewFeedback(allIds, praised, criticized);
				}
			}

			// 记录违规（如果 review FAIL 且有具体违规描述）
			if (!verdict.passed && verdict.findings) {
				for (const finding of verdict.findings) {
					const agentId = extractAgentFromFinding(finding);
					if (agentId && profileRegistry.has(agentId)) {
						const severity = finding.includes("critical") ? "critical" as const
							: finding.includes("major") ? "major" as const
							: "minor" as const;

						profileRegistry.recordViolation(agentId, {
							type: "cloner_review_failure",
							severity,
							description: finding.slice(0, 200),
							iteration,
						});
					}
				}
			}

			// 放置 warning Mark 如果 review FAIL
			if (!verdict.passed) {
				markEnvironment.placeMark({
					markId: `cloner-warning-${iteration}-${Date.now()}`,
					type: "warning",
					agentId: "cloner-council",
					message: `Cloner review FAIL at iteration ${iteration}. Findings: ${(verdict.findings ?? []).join("; ").slice(0, 200)}`,
					priority: "high",
					ttlMs: 60 * 60 * 1000, // 1 hour
					tags: ["review-fail", `iteration-${iteration}`],
				});
			}
		},

		// ── onHookError ───────────────────────────────────────────

		onHookError(hookName: string, error: unknown) {
			logger.warn("[SwarmHooks] Hook error — non-fatal", {
				hook: hookName,
				error: String(error),
			});
		},
	};

	return { hooks, context };
}

// ============================================================================
// Heuristic helpers (simple keyword-based — Cloner findings are human text)
// ============================================================================

/** 从 Cloner findings 中提取被赞扬的 Agent ID */
function extractPraisedAgents(findings: string[]): string[] {
	const praised: string[] = [];
	for (const finding of findings) {
		const lower = finding.toLowerCase();
		if (
			lower.includes("praise") ||
			lower.includes("good") ||
			lower.includes("excellent") ||
			lower.includes("well done") ||
			lower.includes("approved")
		) {
			// 尝试提取 Worker ID（格式：word characters / hyphens）
			const match = finding.match(/\b(worker-[a-zA-Z0-9-]+)\b/);
			if (match) praised.push(match[1]);
		}
	}
	return praised;
}

/** 从 Cloner findings 中提取被批评的 Agent ID */
function extractCriticizedAgents(findings: string[]): string[] {
	const criticized: string[] = [];
	for (const finding of findings) {
		const lower = finding.toLowerCase();
		if (
			lower.includes("issue") ||
			lower.includes("fail") ||
			lower.includes("error") ||
			lower.includes("bug") ||
			lower.includes("wrong") ||
			lower.includes("incorrect") ||
			lower.includes("reject")
		) {
			const match = finding.match(/\b(worker-[a-zA-Z0-9-]+)\b/);
			if (match) criticized.push(match[1]);
		}
	}
	return criticized;
}

/** 从 Cloner finding 文本中提取指涉的 Agent ID */
function extractAgentFromFinding(finding: string): string | null {
	const match = finding.match(/\b(worker-[a-zA-Z0-9-]+)\b/);
	return match ? match[1] : null;
}
