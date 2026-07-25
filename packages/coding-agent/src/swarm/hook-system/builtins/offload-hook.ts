/**
 * Offload Hook — L1 summarization and flush triggers.
 *
 * Builtin hook (priority 2) that wires agent completion, phase transitions,
 * and roundtable rounds into the offload pipeline. Uses a placeholder
 * OffloadManager interface until the full offload system is refactored.
 *
 * @module hook-system/builtins/offload-hook
 */

import type { Chapter } from "../../core/state";
import type { HookEvent, HookPayload, HookContext, HookRegistration } from "../types";
import { logger } from "@oh-my-pi/pi-utils";

// ---------------------------------------------------------------------------
// Placeholder OffloadManager interface
// ---------------------------------------------------------------------------

/**
 * Placeholder interface for the offload subsystem.
 *
 * Will be replaced by the actual OffloadManager when the offload refactor
 * is complete. Both methods are intentionally fire-and-forget — the hook
 * does not block on offload results.
 */
export interface OffloadManager {
  /** Perform an L1 (lightweight) summarize for an agent's output. */
  summarizeL1(agentId: string, content: unknown): Promise<void>;
  /** Force-flush all pending offload data to persistent storage. */
  forceFlush(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Active phases for this hook
// ---------------------------------------------------------------------------

/** Phases during which the offload hook is active. */
const ACTIVE_PHASES: Chapter[] = ["script", "script-debate", "stage", "curtain"];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an offload-management hook.
 *
 * Events (phase-restricted to script, script-debate, stage, curtain):
 * - `agent:afterComplete`    → triggers L1 summarization
 * - `workflow:beforePhase`   → force-flushes pending offloads
 * - `roundtable:afterRound`  → triggers L1 summarization
 *
 * @param offloadManager - The offload subsystem instance.
 */
export function createOffloadHook(
  offloadManager: OffloadManager,
): HookRegistration {
  return {
    name: "offload-hook",
    priority: 2,
    events: ["agent:afterComplete", "workflow:beforePhase", "roundtable:afterRound"],
    phases: ACTIVE_PHASES,

    async handler(
      event: HookEvent,
      payload: HookPayload,
      ctx: HookContext,
    ): Promise<void> {
      const agentId = resolveAgentId(payload, ctx);

      switch (event) {
        // -----------------------------------------------------------------
        // agent:afterComplete — L1 summarize
        // -----------------------------------------------------------------
        case "agent:afterComplete": {
          if (!agentId) {
            logger.warn("[OffloadHook] agent:afterComplete missing agentId");
            return;
          }
          await offloadManager.summarizeL1(agentId, payload);
          logger.debug("[OffloadHook] L1 summarize triggered", { agentId });
          return;
        }

        // -----------------------------------------------------------------
        // workflow:beforePhase — flush pending data
        // -----------------------------------------------------------------
        case "workflow:beforePhase": {
          await offloadManager.forceFlush();
          logger.debug("[OffloadHook] Force-flush completed", {
            phase: ctx.phase,
          });
          return;
        }

        // -----------------------------------------------------------------
        // roundtable:afterRound — L1 summarize
        // -----------------------------------------------------------------
        case "roundtable:afterRound": {
          if (!agentId) {
            logger.warn("[OffloadHook] roundtable:afterRound missing agentId");
            return;
          }
          await offloadManager.summarizeL1(agentId, payload);
          logger.debug("[OffloadHook] Roundtable L1 summarize", { agentId });
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
function resolveAgentId(
  payload: HookPayload,
  ctx: HookContext,
): string | undefined {
  if (typeof payload.agentId === "string") return payload.agentId;
  if (typeof ctx.agentId === "string") return ctx.agentId;
  return undefined;
}
