/**
 * Profile Hook — agent credit and identity management.
 *
 * Builtin hook (priority 0) that wires agent lifecycle events into
 * the ProfileRegistry for cross-run identity tracking.
 *
 * @module hook-system/builtins/profile-hook
 */

import type { HookEvent, HookPayload, HookContext, HookRegistration } from "../types";
import type { ProfileRegistry } from "../../agent/agent-profile";
import { logger } from "@oh-my-pi/pi-utils";

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
export function createProfileHook(
  profileRegistry: ProfileRegistry,
): HookRegistration {
  return {
    name: "profile-hook",
    priority: 0,
    events: ["agent:beforeSpawn", "agent:afterComplete", "workflow:afterPhase"],

    async handler(
      event: HookEvent,
      payload: HookPayload,
      ctx: HookContext,
    ): Promise<void> {
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
          const name = typeof payload.name === "string" ? payload.name : agentId;
          const archetype =
            typeof payload.archetype === "string" ? payload.archetype : "worker";
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
          const agentIds = extractStringArray(payload.agentIds);
          if (agentIds.length > 0) {
            profileRegistry.recordCollaboration(agentIds);
            logger.debug("[ProfileHook] Collaboration recorded", { agentIds });
          }
          return;
        }

        default:
          return;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a string agentId from payload or context. */
function resolveAgentId(payload: HookPayload, ctx: HookContext): string | undefined {
  if (typeof payload.agentId === "string") return payload.agentId;
  if (typeof ctx.agentId === "string") return ctx.agentId;
  return undefined;
}

/** Safely extract a string array from an unknown payload value. */
function extractStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}
