/**
 * Experience Hook — persistent loop experience bridge.
 *
 * Builtin hook (priority 4) that bridges offload-flush data and
 * phase-completion summaries into the ExperienceStore for cross-run
 * learning. Also handles experience weight decay.
 *
 * @module hook-system/builtins/experience-hook
 */

import type { Chapter } from "../../core/state";
import type { HookEvent, HookPayloadMap, HookContext, HookRegistration } from "../types";
import type { ExperienceStore } from "../../curtain/experience";
import { logger } from "@oh-my-pi/pi-utils";

// ---------------------------------------------------------------------------
// Active phases for this hook
// ---------------------------------------------------------------------------

/** Phases during which the experience hook is active. */
const ACTIVE_PHASES: Chapter[] = ["stage", "curtain"];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an experience-management hook.
 *
 * Events (phase-restricted to stage and curtain):
 * - `offload:afterFlush`  → bridges offload data into the experience store
 * - `workflow:afterPhase` → saves session summary and decays unreferenced lessons
 *
 * @param experienceStore - The ExperienceStore instance.
 */
export function createExperienceHook(
  experienceStore: ExperienceStore,
): HookRegistration {
  return {
    name: "experience-hook",
    priority: 4,
    events: ["offload:afterFlush", "workflow:afterPhase"],
    phases: ACTIVE_PHASES,

    async handler<K extends HookEvent>(
      event: K,
      payload: HookPayloadMap[K],
      _ctx: HookContext,
    ): Promise<void> {
      switch (event) {
        // -----------------------------------------------------------------
        // offload:afterFlush — bridge offload data to experience store
        // -----------------------------------------------------------------
        case "offload:afterFlush": {
          // payload is OffloadFlushPayload
          if (payload.entry) {
            try {
              await experienceStore.saveLesson(payload.entry as Parameters<ExperienceStore["saveLesson"]>[0]);
              logger.debug("[ExperienceHook] Bridged offload entry to experience", {
                runId: payload.runId,
              });
            } catch (err: unknown) {
              logger.warn("[ExperienceHook] Failed to bridge offload entry", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          return;
        }

        // -----------------------------------------------------------------
        // workflow:afterPhase — save session summary + decay unreferenced
        // -----------------------------------------------------------------
        case "workflow:afterPhase": {
          // payload is WorkflowAfterPhasePayload
          if (payload.sessionSummary) {
            try {
              await experienceStore.saveLesson(payload.sessionSummary as Parameters<ExperienceStore["saveLesson"]>[0]);
              logger.debug("[ExperienceHook] Session summary stored");
            } catch (err: unknown) {
              logger.warn("[ExperienceHook] Failed to store session summary", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          // runIds is typed as string[] | undefined — use directly
          const runIds = payload.runIds ?? [];
          if (runIds.length > 0) {
            try {
              await experienceStore.markReferenced(runIds);
              logger.debug("[ExperienceHook] Referenced run IDs marked", { runIds });
            } catch (err: unknown) {
              logger.warn("[ExperienceHook] Failed to mark referenced runs", {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          try {
            await experienceStore.decayUnreferenced(runIds);
            logger.debug("[ExperienceHook] Decay applied", { runIds });
          } catch (err: unknown) {
            logger.warn("[ExperienceHook] Failed to decay unreferenced", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }

        default:
          return;
      }
    },
  };
}
