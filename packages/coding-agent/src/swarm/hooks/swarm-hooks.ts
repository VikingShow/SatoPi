/**
 * swarm-hooks.ts — AgentProfile + Stigmergy lifecycle feedback for StageController
 *
 * 设计原则：
 * 1. StageController 零依赖 — 通过 StageCallbacks 接口注入
 * 2. ProfileRegistry + MarkEnvironment 通过 SwarmHooksConfig 注入
 * 3. 回调失败不崩溃 Stage — 所有内部操作自行容错
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent";
import type { ProfileRegistry } from "../agent/agent-profile";
import type { MarkEnvironment } from "../coordination/mark-environment";
import type { StageCallbacks } from "../stage/stage-controller";
import type { Task } from "../executor/task-queue";
import type { ScoredAgent } from "../agent/agent-selector";

// ============================================================================
// Types
// ============================================================================

export interface SwarmHooksConfig {
	enabled: boolean;
	profileRegistry: ProfileRegistry;
	markEnvironment: MarkEnvironment;
}

// ============================================================================
// createStageFeedback — StageController 专用反馈工厂
// ============================================================================

/**
 * Create StageCallbacks that wire Profile credit updates + Stigmergy marks
 * into the StageController lifecycle.
 *
 * When stigmergy is disabled, returns stub callbacks that no-op.
 */
export function createStageFeedback(config: SwarmHooksConfig): StageCallbacks {
	const { profileRegistry, markEnvironment, enabled } = config;

	if (!enabled) {
		return {
			onAgentsSelected: () => {},
			onTaskCompleted: () => {},
			onTaskFailed: () => {},
			onStageComplete: () => {},
			getAgentContext: () => null,
		};
	}

	const registeredProfiles = new Set<string>();

	return {
		// ── Agent selection ──────────────────────────────────────

		onAgentsSelected(agents: ScoredAgent[]) {
			for (const a of agents) {
				if (!registeredProfiles.has(a.profileId)) {
					profileRegistry.getOrCreate({
						profileId: a.profileId,
						name: a.name,
						archetype: a.archetype,
						description: `Stage agent — ${a.archetype}`,
					});
					registeredProfiles.add(a.profileId);
				}
			}

			const ids = agents.map(a => a.profileId);
			profileRegistry.recordCollaboration(ids);

			logger.info("[StageFeedback] Agents selected for stage", {
				count: agents.length,
				ids: agents.map(a => a.profileId),
			});
		},

		// ── Task completed ───────────────────────────────────────

		onTaskCompleted(agentId: string, task: Task, _result: SingleResult) {
			profileRegistry.recordTaskCompleted(agentId, true, {
				domain: task.type,
				role: task.assignedRole,
			});

			markEnvironment.placeMark({
				markId: `artifact-${agentId}-${task.id}-${Date.now()}`,
				type: "artifact",
				agentId,
				message: `${agentId} completed ${task.title}`,
				priority: "medium",
				ttlMs: 30 * 60 * 1000,
				tags: ["task-completed", task.type],
			});
		},

		// ── Task failed ──────────────────────────────────────────

		onTaskFailed(agentId: string, task: Task, error: string) {
			profileRegistry.recordTaskCompleted(agentId, false);

			markEnvironment.placeMark({
				markId: `warning-${agentId}-${task.id}-${Date.now()}`,
				type: "warning",
				agentId,
				message: `${agentId} failed ${task.title}: ${error.slice(0, 200)}`,
				priority: "high",
				ttlMs: 60 * 60 * 1000,
				tags: ["task-failed", task.type],
			});
		},

		// ── Stage complete ───────────────────────────────────────

		onStageComplete(_result) {
			logger.info("[StageFeedback] Stage complete", {
				activeProfiles: registeredProfiles.size,
			});
		},

		// ── Prompt context injection ─────────────────────────────

		getAgentContext(agentId: string): string | null {
			const parts: string[] = [];

			const profileCtx = profileRegistry.getPromptContext(agentId);
			if (profileCtx) parts.push(profileCtx);

			const markCtx = markEnvironment.getContextForAgent(agentId);
			if (markCtx) parts.push(markCtx);

			return parts.length > 0 ? parts.join("\n") : null;
		},
	};
}
