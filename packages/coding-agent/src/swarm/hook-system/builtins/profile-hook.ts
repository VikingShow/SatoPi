/**
 * Profile Hook — agent credit and identity management.
 *
 * Builtin hook (priority 0) that wires agent lifecycle events into
 * the ProfileRegistry for cross-run identity tracking.
 *
 * @module hook-system/builtins/profile-hook
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { ProfileRegistry } from "../../agent/agent-profile";
import type { HookContext, HookEvent, HookPayloadMap, HookRegistration } from "../types";
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
			// Resolve agentId from payload first, then context
			const agentId = resolveAgentId(payload, ctx);

			switch (event) {
				// -----------------------------------------------------------------
				// agent:beforeSpawn — ensure profile exists
				// -----------------------------------------------------------------
				case "agent:beforeSpawn": {
					if (!agentId) {
						logger.warn("[ProfileHook] agent:beforeSpawn missing agentId", { payload });
						return;
					}
					// payload is AgentBeforeSpawnPayload at this point
					const name = payload.name ?? agentId;
					const archetype = payload.archetype ?? "worker";
					profileRegistry.getOrCreate({ profileId: agentId, name, archetype });
					logger.debug("[ProfileHook] Profile ensured", { agentId, name });
					return;
				}

				// -----------------------------------------------------------------
				// agent:afterComplete — record task result
				// -----------------------------------------------------------------
				case "agent:afterComplete": {
					if (!agentId) {
						logger.warn("[ProfileHook] agent:afterComplete missing agentId", { payload });
						return;
					}
					// payload is AgentAfterCompletePayload
					const success = payload.success !== false;
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
					// payload is WorkflowAfterPhasePayload
					const agentIds = payload.agentIds ?? [];
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
