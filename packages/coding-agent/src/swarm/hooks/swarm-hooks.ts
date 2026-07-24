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
 *   beforeAgentRound   → 可跳过
 *   afterWorkerRound    → 记录任务完成 + 更新信用分 + 放置 artifact Mark
 *   afterClonerReview   → 记录 praise/criticism → 更新信用分
 *   onHookError         → 日志
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { LoopPipelineHooks, PipelineContext } from "../core/pipeline";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent";
import type { ReviewVerdict } from "../core/pipeline";
import type { ProfileRegistry } from "../agent/agent-profile";
import type { MarkEnvironment } from "../coordination/mark-environment";

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

		// ── beforeAgentRound ─────────────────────────────────────

		async beforeAgentRound(round: number, agentIds: string[], _ctx: PipelineContext) {
			if (!config.enabled) return;

			// 确保所有 Worker 都有 Profile（幂等注册）
			for (const id of agentIds) {
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
			allAgentIds = [...new Set([...allAgentIds, ...agentIds])];

			// 记录协作关系
			profileRegistry.recordCollaboration(agentIds);

			// 为每个 Worker 放置 start-round Mark
			for (const id of agentIds) {
				markEnvironment.placeMark({
					markId: `worker-${id}-round-${round}-${Date.now()}`,
					type: "signal",
					agentId: id,
					message: `Worker ${id} started round ${round}`,
					priority: "low",
					ttlMs: 10 * 60 * 1000, // 10 min
				});
			}

			logger.debug("[SwarmHooks] Worker round started", { round, workers: agentIds.length });
		},

		// ── afterAgentRound ──────────────────────────────────────

		async afterAgentRound(round: number, results: SingleResult[], _ctx: PipelineContext) {
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

		// ── beforeReview ────────────────────────────────────

		async beforeReview(_iteration: number, _agentOutput: string, _ctx: PipelineContext) {
			if (!config.enabled) return;
			// no-op for now — cloner profiles registered on next cloner run
		},

		// ── afterReview ─────────────────────────────────────

		async afterReview(iteration: number, verdict: ReviewVerdict | null, _ctx: PipelineContext) {
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
// Cloner review extraction — hybrid structured + heuristic
// ============================================================================

/**
 * 通用 Agent ID 模式：字母开头，包含至少一个连字符/下划线/数字
 * （避免匹配 FAIL/BUG/ERROR 等纯字母英文词汇）。
 *
 * 匹配示例: agent-1, agent-2, planner, reviewer
 * 不匹配:   FAIL, PASS, bug, error, critical, major
 */
const AGENT_ID_RE = /\b([a-z][a-z0-9_-]*(?:[0-9_-])[a-z0-9_-]{0,31})\b/i;

/**
 * Cloner 可在 findings 中使用结构化标签，格式：
 *   [PRAISE:agent-id]    — 明确赞扬
 *   [CRITICIZE:agent-id] — 明确批评
 *   [FAIL:agent-id]      — 严重问题
 *   [PASS:agent-id]      — 通过
 *
 * 标签不区分大小写。这些标签比关键字启发式具有更高的置信度。
 */
const STRUCTURED_RE = /\[(PRAISE|CRITICIZE|FAIL|PASS):\s*([^\]]+)\]/gi;

/** 赞扬关键字 */
const PRAISE_KEYWORDS = [
	"praise", "good", "excellent", "well done", "approved",
	"well-done", "great", "outstanding", "superb", "exceeds",
];
/** 批评关键字 */
const CRITICIZE_KEYWORDS = [
	"issue", "fail", "error", "bug", "wrong", "incorrect",
	"reject", "broken", "missing", "incomplete", "flaw",
];

/**
 * 从 Cloner findings 中提取结构化标签 + 关键字匹配的 Agent ID。
 *
 * 分为两层：
 * 1. 结构化标签（高置信度）— `[PRAISE:agent-1]` 直接提取
 * 2. 关键字 + 邻近 Agent ID（中置信度）— "worker-3 produced broken output"
 */
function extractStructuredAgents(
	findings: string[],
): { praised: string[]; criticized: string[]; structured: boolean } {
	const praised = new Set<string>();
	const criticized = new Set<string>();

	for (const finding of findings) {
		// ── Layer 1: 结构化标签 ──────────────────────────────────
		STRUCTURED_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = STRUCTURED_RE.exec(finding)) !== null) {
			const label = match[1].toUpperCase();
			// 标签内可能包含多个逗号分隔的 ID
			const ids = match[2]
				.split(/[,\s]+/)
				.map(s => s.trim())
				.filter(s => s.length > 0 && /^[a-z][a-z0-9_-]+$/i.test(s));

			for (const id of ids) {
				if (label === "PRAISE" || label === "PASS") praised.add(id);
				else criticized.add(id);
			}
		}

		// ── Layer 2: 关键字 + 邻近 Agent ID ─────────────────────
		// 只在结构化标签未匹配时才用关键字补充
		const lower = finding.toLowerCase();

		// 先收集该 finding 中所有 Agent ID
		const allIds = (finding.match(new RegExp(AGENT_ID_RE.source, "gi")) ?? [])
			.map(s => s.toLowerCase()) as string[];

		if (allIds.length === 0) continue;

		// 关键字判断方向
		const isPraise = PRAISE_KEYWORDS.some(k => lower.includes(k));
		const isCriticize = CRITICIZE_KEYWORDS.some(k => lower.includes(k));

		// 如果同时包含赞扬和批评关键字，以强信号为准
		// (criticize 信号比 praise 信号更明确有具体问题)
		if (isCriticize && !isPraise) {
			for (const id of allIds) {
				if (!praised.has(id)) criticized.add(id);
			}
		} else if (isPraise && !isCriticize) {
			for (const id of allIds) {
				if (!criticized.has(id)) praised.add(id);
			}
		}
		// 如果同时包含 praise 和 criticize，不做判断（歧义）
	}

	return {
		praised: [...praised],
		criticized: [...criticized],
		structured: true, // always try structured first
	};
}

/** 从 Cloner findings 中提取被赞扬的 Agent ID（兼容旧接口） */
function extractPraisedAgents(findings: string[]): string[] {
	return extractStructuredAgents(findings).praised;
}

/** 从 Cloner findings 中提取被批评的 Agent ID（兼容旧接口） */
function extractCriticizedAgents(findings: string[]): string[] {
	return extractStructuredAgents(findings).criticized;
}

/** 从 Cloner finding 文本中提取指涉的 Agent ID（优先结构化标签） */
function extractAgentFromFinding(finding: string): string | null {
	// 先尝试结构化标签
	STRUCTURED_RE.lastIndex = 0;
	const structured = STRUCTURED_RE.exec(finding);
	if (structured) {
		const ids = structured[2].split(/[,\s]+/).filter(s => s.trim()).map(s => s.trim());
		return ids[0] ?? null;
	}
	// Fallback: 通用 Agent ID 匹配
	const match = finding.match(AGENT_ID_RE);
	return match ? match[1] : null;
}
