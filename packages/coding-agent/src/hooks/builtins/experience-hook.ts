/**
 * Experience Hook — persistent loop experience bridge.
 *
 * Builtin hook (priority 4) that bridges offload-flush data and
 * phase-completion summaries into the ExperienceStore for cross-run
 * learning. Also handles experience weight decay.
 *
 * @module hook-system/builtins/experience-hook
 */

import { logger } from "@satopi/pi-utils";
import type { ExperienceEntry, ExperienceStore } from "../../experience/experience";
import type { Chapter } from "../../types/chapter";
import type { HandlerArgs, HookContext, HookRegistration } from "../types";

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
export function createExperienceHook(experienceStore: ExperienceStore): HookRegistration {
	return {
		name: "experience-hook",
		priority: 4,
		events: ["offload:afterFlush", "workflow:afterPhase"],
		phases: ACTIVE_PHASES,

		async handler({ event, payload }: HandlerArgs, _ctx: HookContext): Promise<boolean | undefined> {
			switch (event) {
				// -----------------------------------------------------------------
				// offload:afterFlush — bridge offload data to experience store
				// -----------------------------------------------------------------
				case "offload:afterFlush": {
					if (payload.entry) {
						try {
							await experienceStore.saveLesson(payload.entry as ExperienceEntry);
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
					if (payload.sessionSummary) {
						try {
							await experienceStore.saveLesson(payload.sessionSummary as ExperienceEntry);
							logger.debug("[ExperienceHook] Session summary stored");
						} catch (err: unknown) {
							logger.warn("[ExperienceHook] Failed to store session summary", {
								error: err instanceof Error ? err.message : String(err),
							});
						}
					}

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
