/**
 * Stigmergy Hook — environmental signal placement from agent events.
 *
 * Builtin hook (priority 1) that translates agent lifecycle events into
 * stigmergic marks on the MarkEnvironment for indirect coordination.
 *
 * @module hook-system/builtins/stigmergy-hook
 */

import { logger } from "@satopi/pi-utils";
import type { MarkEnvironment } from "../../coordination";
import type { HandlerArgs, HookContext, HookRegistration } from "../types";
import { resolveAgentId } from "../utils";

/**
 * Create a stigmergy-signalling hook.
 *
 * Events:
 * - `agent:afterComplete`     → places an "artifact" mark
 * - `agent:onError`           → places a high-priority "warning" mark
 * - `context:afterCompaction` → logs mark summary for observability
 *
 * @param markEnv - The MarkEnvironment instance to place marks on.
 */
export function createStigmergyHook(markEnv: MarkEnvironment): HookRegistration {
	return {
		name: "stigmergy-hook",
		priority: 1,
		events: ["agent:afterComplete", "agent:onError", "context:afterCompaction"],

		async handler({ event, payload }: HandlerArgs, ctx: HookContext): Promise<void> {
			switch (event) {
				// -----------------------------------------------------------------
				// agent:afterComplete — place artifact mark
				// -----------------------------------------------------------------
				case "agent:afterComplete": {
					const agentId = resolveAgentId(payload, ctx);
					if (!agentId) {
						logger.warn("[StigmergyHook] agent:afterComplete missing agentId");
						return;
					}
					const artifactPath = payload.artifactPath;
					const message = payload.message ?? `Agent ${agentId} completed task`;

					markEnv.placeMark({
						markId: generateMarkId(agentId, "artifact"),
						type: "artifact",
						agentId,
						path: artifactPath,
						message,
					});
					logger.debug("[StigmergyHook] Artifact mark placed", { agentId });
					return;
				}

				// -----------------------------------------------------------------
				// agent:onError — place warning mark
				// -----------------------------------------------------------------
				case "agent:onError": {
					const agentId = resolveAgentId(payload, ctx);
					if (!agentId) {
						logger.warn("[StigmergyHook] agent:onError missing agentId");
						return;
					}
					const errorMessage = payload.error;

					markEnv.placeMark({
						markId: generateMarkId(agentId, "warning"),
						type: "warning",
						agentId,
						message: errorMessage,
						priority: "high",
					});
					logger.debug("[StigmergyHook] Warning mark placed", { agentId });
					return;
				}

				// -----------------------------------------------------------------
				// context:afterCompaction — observability
				// -----------------------------------------------------------------
				case "context:afterCompaction": {
					const summary = markEnv.getSummary();
					logger.debug("[StigmergyHook] Post-compaction mark summary", summary);
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

/** Generate a unique markId scoped to agent and type. */
function generateMarkId(agentId: string, type: string): string {
	return `${agentId}-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
