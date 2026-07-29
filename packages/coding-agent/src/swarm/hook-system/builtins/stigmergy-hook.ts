/**
 * Stigmergy Hook — environmental signal placement from agent events.
 *
 * Builtin hook (priority 1) that translates agent lifecycle events into
 * stigmergic marks on the MarkEnvironment for indirect coordination.
 *
 * @module hook-system/builtins/stigmergy-hook
 */

import { logger } from "@satopi/pi-utils";
import type { MarkEnvironment } from "../../../coordination";
import type {
	AgentAfterCompletePayload,
	AgentOnErrorPayload,
	HookContext,
	HookEvent,
	HookPayloadMap,
	HookRegistration,
} from "../types";
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

		async handler<K extends HookEvent>(event: K, payload: HookPayloadMap[K], ctx: HookContext): Promise<void> {
			const agentId = resolveAgentId(payload as unknown as { agentId?: unknown }, ctx);

			switch (event) {
				// -----------------------------------------------------------------
				// agent:afterComplete — place artifact mark
				// -----------------------------------------------------------------
				case "agent:afterComplete": {
					if (!agentId) {
						logger.warn("[StigmergyHook] agent:afterComplete missing agentId");
						return;
					}
					// payload is AgentAfterCompletePayload
					const p = payload as unknown as AgentAfterCompletePayload;
					const artifactPath = p.artifactPath;
					const message = p.message ?? `Agent ${agentId} completed task`;

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
					if (!agentId) {
						logger.warn("[StigmergyHook] agent:onError missing agentId");
						return;
					}
					const p = payload as unknown as AgentOnErrorPayload;
					const errorMessage = p.error;

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
