/**
 * Profile Hook — agent credit and identity management.
 *
 * Builtin hook (priority 0) that wires agent lifecycle events into
 * the ProfileRegistry for cross-run identity tracking.
 *
 * @module hook-system/builtins/profile-hook
 */

import { logger } from "@satopi/pi-utils";
import type { ProfileRegistry } from "../../../agent/agent-profile";
import type {
	AgentAfterCompletePayload,
	AgentBeforeSpawnPayload,
	HookContext,
	HookEvent,
	HookPayloadMap,
	HookRegistration,
	WorkflowAfterPhasePayload,
} from "../types";
import { resolveAgentId } from "../utils";

/**
 * Create a profile-tracking hook.
 *
 * Events:
 * - `agent:beforeSpawn`  → ensures a profile exists (getOrCreate)
 * - `agent:afterComplete` → records task completion (success/failure)
 * - `workflow:afterPhase` → records mutual collaboration between agents
 *
 * @param profileRegistry - The ProfileRegistry instance to delegate to.
 */
export function createProfileHook(profileRegistry: ProfileRegistry): HookRegistration {
	return {
		name: "profile-hook",
		priority: 0,
		events: ["agent:beforeSpawn", "agent:afterComplete", "workflow:afterPhase"],

		async handler<K extends HookEvent>(event: K, payload: HookPayloadMap[K], ctx: HookContext): Promise<void> {
			switch (event) {
				// -----------------------------------------------------------------
				// agent:beforeSpawn — ensure profile exists
				// -----------------------------------------------------------------
				case "agent:beforeSpawn": {
					const p = payload as unknown as AgentBeforeSpawnPayload;
					const agentId = resolveAgentId(p, ctx);
					if (!agentId) {
						logger.warn("[ProfileHook] agent:beforeSpawn missing agentId", { payload: p });
						return;
					}
					const name = p.name ?? agentId;
					const archetype = p.archetype ?? "worker";
					profileRegistry.getOrCreate({ profileId: agentId, name, archetype });
					logger.debug("[ProfileHook] Profile ensured", { agentId, name });
					return;
				}

				// -----------------------------------------------------------------
				// agent:afterComplete — record task result
				// -----------------------------------------------------------------
				case "agent:afterComplete": {
					const p = payload as unknown as AgentAfterCompletePayload;
					const agentId = resolveAgentId(p, ctx);
					if (!agentId) {
						logger.warn("[ProfileHook] agent:afterComplete missing agentId", { payload: p });
						return;
					}
					const success = p.success !== false;
					profileRegistry.recordTaskCompleted(agentId, success);
					logger.debug("[ProfileHook] Task completion recorded", {
						agentId,
						success,
					});
					return;
				}

				// -----------------------------------------------------------------
				// workflow:afterPhase — record collaboration
				// -----------------------------------------------------------------
				case "workflow:afterPhase": {
					const p = payload as unknown as WorkflowAfterPhasePayload;
					const agentIds = p.agentIds ?? [];
					const filtered = agentIds.filter((v): v is string => typeof v === "string");
					if (filtered.length > 0) {
						profileRegistry.recordCollaboration(filtered);
						logger.debug("[ProfileHook] Collaboration recorded", { agentIds: filtered });
					}
					return;
				}

				default:
					return;
			}
		},
	};
}
