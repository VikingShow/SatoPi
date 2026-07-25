/**
 * Mnemopi Hook — semantic memory recall and storage.
 *
 * Builtin hook (priority 3) that wires agent spawn and completion events
 * into the SwarmMnemopiAdapter for historical context injection and
 * persistent memory storage.
 *
 * @module hook-system/builtins/mnemopi-hook
 */

import type { HookEvent, HookPayload, HookContext, HookRegistration } from "../types";
import type { SwarmMnemopiAdapter } from "../../hooks/mnemopi-adapter";
import { logger } from "@oh-my-pi/pi-utils";

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
export function createMnemopiHook(
  adapter: SwarmMnemopiAdapter,
): HookRegistration {
  return {
    name: "mnemopi-hook",
    priority: 3,
    events: ["agent:beforeSpawn", "agent:afterComplete"],

    async handler(
      event: HookEvent,
      payload: HookPayload,
      _ctx: HookContext,
    ): Promise<void> {
      switch (event) {
        // -----------------------------------------------------------------
        // agent:beforeSpawn — recall historical context
        // -----------------------------------------------------------------
        case "agent:beforeSpawn": {
          const planSummary =
            typeof payload.planSummary === "string"
              ? payload.planSummary
              : "";
          const taskSummary =
            typeof payload.taskSummary === "string"
              ? payload.taskSummary
              : "";

          try {
            const recallResult = await adapter.recallForIteration(
              planSummary,
              taskSummary,
            );
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
        // agent:afterComplete — store iteration results
        // -----------------------------------------------------------------
        case "agent:afterComplete": {
          if (typeof payload.summary !== "string") {
            return;
          }
          const summary: string = payload.summary;
          const score: number =
            typeof payload.score === "number" ? payload.score : 0;

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
          return;
        }

        default:
          return;
      }
    },
  };
}


