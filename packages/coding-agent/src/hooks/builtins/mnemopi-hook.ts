/**
 * Mnemopi Hook — semantic memory recall and storage.
 *
 * Builtin hook (priority 3) that wires agent spawn and completion events
 * into the SwarmMnemopiAdapter for historical context injection and
 * persistent memory storage.
 *
 * The hook is also the memory-coordination point for the three memory
 * systems: the single `agent:afterComplete` summary is fanned out to the
 * semantic store (adapter), the ExperienceStore, and the memories backend,
 * so one completed agent feeds all three from the same event payload.
 *
 * @module hook-system/builtins/mnemopi-hook
 */

import { logger } from "@satopi/pi-utils";
import type { ExperienceEntry, ExperienceStore } from "../../experience/experience";
import type { MemoryRuntimeContext } from "../../memory-backend/types";
import type { SwarmMnemopiAdapter } from "../../swarm/infra/mnemopi-adapter";
import type { AgentAfterCompletePayload, HandlerArgs, HookContext, HookRegistration } from "../types";

/**
 * Optional coordination sinks for the completion event.
 *
 * When provided, `agent:afterComplete` fans the summary out to all three
 * memory systems. Sinks are optional and each failure is isolated — a memory
 * outage must never block the agent pipeline.
 */
export interface MnemopiHookCoordinationDeps {
	/** ExperienceStore — persist the completion summary as a lesson. */
	experienceStore?: Pick<ExperienceStore, "saveLesson">;
	/** Memories backend — capture the completion summary as a learned lesson. */
	memories?: Pick<MemoryRuntimeContext, "save">;
}

/**
 * Create a mnemopi memory hook.
 *
 * Events:
 * - `agent:beforeSpawn`  → recall relevant historical context
 * - `agent:afterComplete` → store high-scoring iteration results and fan the
 *   summary out to the optional coordination sinks (ExperienceStore, memories).
 *
 * All operations are wrapped in try/catch — mnemopi failures should never
 * block the agent pipeline.
 *
 * @param adapter - The SwarmMnemopiAdapter instance.
 * @param coordination - Optional sinks for the other two memory systems.
 */
export function createMnemopiHook(
	adapter: SwarmMnemopiAdapter,
	coordination: MnemopiHookCoordinationDeps = {},
): HookRegistration {
	return {
		name: "mnemopi-hook",
		priority: 3,
		events: ["agent:beforeSpawn", "agent:afterComplete"],

		async handler({ event, payload }: HandlerArgs, _ctx: HookContext): Promise<boolean | undefined> {
			switch (event) {
				// -----------------------------------------------------------------
				// agent:beforeSpawn — recall historical context
				// -----------------------------------------------------------------
				case "agent:beforeSpawn": {
					const planSummary = payload.planSummary ?? "";
					const taskSummary = payload.taskSummary ?? "";

					try {
						const recallResult = await adapter.recallForIteration(planSummary, taskSummary);
						logger.debug("[MnemopiHook] Recall completed", {
							agentId: payload.agentId,
							hasResults: !!recallResult,
						});
					} catch (err: unknown) {
						logger.warn("[MnemopiHook] Recall failed — continuing", {
							agentId: payload.agentId,
							error: err instanceof Error ? err.message : String(err),
						});
					}
					return;
				}

				// -----------------------------------------------------------------
				// agent:afterComplete — store the summary in all three memory systems
				// -----------------------------------------------------------------
				case "agent:afterComplete": {
					if (!payload.summary) {
						return;
					}
					const summary: string = payload.summary;
					const score: number = payload.score ?? 0;

					// 1. mnemopi — semantic store (self-gated on autoStoreThreshold).
					try {
						await adapter.storeAfterIteration(summary, score);
						logger.debug("[MnemopiHook] Iteration stored", {
							agentId: payload.agentId,
						});
					} catch (err: unknown) {
						logger.warn("[MnemopiHook] Store failed — continuing", {
							agentId: payload.agentId,
							error: err instanceof Error ? err.message : String(err),
						});
					}

					// 2. ExperienceStore — persist the same summary as a lesson.
					if (coordination.experienceStore) {
						try {
							coordination.experienceStore.saveLesson(buildCompletionEntry(payload, summary, score));
							logger.debug("[MnemopiHook] Completion summary stored in ExperienceStore", {
								agentId: payload.agentId,
							});
						} catch (err: unknown) {
							logger.warn("[MnemopiHook] ExperienceStore save failed — continuing", {
								agentId: payload.agentId,
								error: err instanceof Error ? err.message : String(err),
							});
						}
					}

					// 3. memories backend — capture the summary as a learned lesson.
					if (coordination.memories) {
						try {
							await coordination.memories.save({
								content: summary,
								source: "agent:afterComplete",
								importance: Math.min(1, Math.max(0, score / 10)),
							});
							logger.debug("[MnemopiHook] Completion summary captured by memories backend", {
								agentId: payload.agentId,
							});
						} catch (err: unknown) {
							logger.warn("[MnemopiHook] Memories save failed — continuing", {
								agentId: payload.agentId,
								error: err instanceof Error ? err.message : String(err),
							});
						}
					}
					return;
				}

				default:
					return;
			}
		},
	};
}

/**
 * Build an ExperienceStore lesson from an agent completion event.
 */
function buildCompletionEntry(payload: AgentAfterCompletePayload, summary: string, score: number): ExperienceEntry {
	const success = payload.success !== false;
	return {
		runId: `agent-${payload.agentId}-${Date.now()}`,
		timestamp: new Date().toISOString(),
		lesson: {
			type: success ? "reflection" : "error",
			summary,
			detail: payload.message ?? summary,
			tags: success ? ["agent-completion", "success"] : ["agent-completion", "failure"],
			confidence: 0.8,
			source: "agent:afterComplete",
		},
		stats: {
			totalIterations: 1,
			finalStatus: success ? "completed" : "failed",
			reviewApprovalRatio: score > 0 ? Math.min(1, Math.max(0, score / 10)) : 1,
			agentCount: 1,
			taskDescription: `agent ${payload.agentId}`,
		},
		nodeId: payload.agentId,
		taskHash: payload.taskId,
	};
}
