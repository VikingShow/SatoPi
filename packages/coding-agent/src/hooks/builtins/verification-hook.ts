/**
 * Verification Hook — run verification commands at curtain phase.
 *
 * Builtin hook (priority 5, highest) that executes shell verification
 * commands when the workflow enters the curtain (wrap-up) phase. This is
 * the last line of defence before results are finalized.
 *
 * @module hook-system/builtins/verification-hook
 */

import { logger } from "@satopi/pi-utils";
import type { VerificationHook } from "../../swarm/core/verification-hook";
import type { Chapter } from "../../types/chapter";
import type { HandlerArgs, HookContext, HookRegistration } from "../types";

// ---------------------------------------------------------------------------
// Active phases for this hook
// ---------------------------------------------------------------------------

/** Phases during which the verification hook is active. */
const ACTIVE_PHASES: Chapter[] = ["curtain"];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a verification hook.
 *
 * Events (phase-restricted to curtain):
 * - `workflow:beforePhase` → runs verification commands from the payload
 *
 * The commands are extracted from `payload.commands` (a `string[]`).
 * Results are logged but do not block the pipeline — failures are
 * surfaced through the logger for operator visibility.
 *
 * @param verification - The VerificationHook instance.
 */
export function createVerificationHook(verification: VerificationHook): HookRegistration {
	return {
		name: "verification-hook",
		priority: 5,
		events: ["workflow:beforePhase"],
		phases: ACTIVE_PHASES,

		async handler({ event, payload }: HandlerArgs, _ctx: HookContext): Promise<boolean | undefined> {
			if (event !== "workflow:beforePhase") {
				return;
			}

			const commands = payload.commands ?? [];

			if (commands.length === 0) {
				logger.debug("[VerificationHook] No verification commands to run");
				return;
			}

			try {
				const result = await verification.run(commands);
				logger.info("[VerificationHook] Verification completed", {
					passed: result.passed,
					total: result.results?.length ?? commands.length,
				});
			} catch (err: unknown) {
				logger.error("[VerificationHook] Verification threw unhandled error", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},
	};
}
