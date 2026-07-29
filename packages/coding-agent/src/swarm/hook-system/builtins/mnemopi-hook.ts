/**
 * Mnemopi Hook — semantic memory recall and storage.
 *
 * Builtin hook (priority 3) that wires agent spawn and completion events
 * into the SwarmMnemopiAdapter for historical context injection and
 * persistent memory storage.
 *
 * @module hook-system/builtins/mnemopi-hook
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { SwarmMnemopiAdapter } from "../../infra/mnemopi-adapter";
import type { HookContext, HookEvent, HookPayloadMap, HookRegistration, AgentBeforeSpawnPayload, AgentAfterCompletePayload } from "../types";

/**
 * Create a mnemopi memory hook.
 *
 * Events:
 * - `agent:beforeSpawn`  → recall relevant historical context
 * - `agent:afterComplete` → store high-scoring iteration results
 *
 * Both operations are wrapped in try/catch — mnemopi failures
 * should never block the agent pipeline.
 *
 * @param adapter - The SwarmMnemopiAdapter instance.
 */
export function createMnemopiHook(adapter: SwarmMnemopiAdapter): HookRegistration {
	return {
		name: "mnemopi-hook",
		priority: 3,
		events: ["agent:beforeSpawn", "agent:afterComplete"],

		async handler<K extends HookEvent>(event: K, payload: HookPayloadMap[K], _ctx: HookContext): Promise<void> {
			switch (event) {
				// -----------------------------------------------------------------
				// agent:beforeSpawn — recall historical context
				// -----------------------------------------------------------------
			case "agent:beforeSpawn": {
				// Narrow payload for TS: switch on event doesn't narrow generic K.
				const p = payload as unknown as AgentBeforeSpawnPayload;
				const planSummary = p.planSummary ?? "";
				const taskSummary = p.taskSummary ?? "";

				try {
					const recallResult = await adapter.recallForIteration(planSummary, taskSummary);
					logger.debug("[MnemopiHook] Recall completed", {
						agentId: p.agentId,
						hasResults: !!recallResult,
					});
				} catch (err: unknown) {
					logger.warn("[MnemopiHook] Recall failed — continuing", {
						agentId: p.agentId,
						error: err instanceof Error ? err.message : String(err),
					});
				}
				return;
			}

				// -----------------------------------------------------------------
				// agent:afterComplete — store iteration results
				// -----------------------------------------------------------------
			case "agent:afterComplete": {
				// Narrow payload for TS: switch on event doesn't narrow generic K.
				const p = payload as unknown as AgentAfterCompletePayload;
				if (!p.summary) {
					return;
				}
				const summary: string = p.summary;
				const score: number = p.score ?? 0;

				try {
					await adapter.storeAfterIteration(summary, score);
					logger.debug("[MnemopiHook] Iteration stored", {
						agentId: p.agentId,
					});
				} catch (err: unknown) {
					logger.warn("[MnemopiHook] Store failed — continuing", {
						agentId: p.agentId,
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
