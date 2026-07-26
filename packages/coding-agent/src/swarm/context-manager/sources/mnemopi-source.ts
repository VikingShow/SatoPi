/**
 * MnemopiSource — Recalls semantic memories related to the agent's task.
 *
 * Priority: 6.
 * Applies to: all phases (but only active if mnemopi client is configured).
 *
 * Uses the MnemopiClient interface to perform semantic recall of past
 * decisions, patterns, and outcomes. The recalled context is injected
 * as a user message so the agent can reference past work.
 *
 * This source is optional — if no client is provided, it produces no context.
 */

import type { ContextSource, ContextFragment, AgentSpecLike, BuildContext } from "../context-pipeline";
import type { Chapter } from "../../core/state";
import type { MnemopiClient } from "../../hooks/mnemopi-adapter";
import { logger } from "@oh-my-pi/pi-utils";

export class MnemopiSource implements ContextSource {
  readonly name = "mnemopi";
  readonly priority = 6;

  readonly #client: MnemopiClient | null;

  constructor(client: MnemopiClient | null = null) {
    this.#client = client;
  }

  appliesTo(_phase: Chapter, _agentRole: string): boolean {
    // Only applies if a client is configured
    return this.#client !== null;
  }

  async build(_spec: AgentSpecLike, base: BuildContext): Promise<ContextFragment> {
    if (!this.#client) {
      return {};
    }

    try {
      const items = await this.#client.recall(base.taskDescription, 5);
      if (items.length === 0) {
        return {};
      }

      const memoriesText = items
        .map((item, i) => {
          const parts: string[] = [`[Memory ${i + 1}]`];
          if (item.score !== undefined) {
            parts.push(`(score: ${item.score.toFixed(2)})`);
          }
          parts.push(item.content.slice(0, 500));
          return parts.join(" ");
        })
        .join("\n");

      const injectedMessage = {
        role: "user" as const,
        timestamp: Date.now(),
        content: [
          "<semantic_memories>",
          `Recalled ${items.length} relevant semantic memories for task: "${base.taskDescription}"`,
          "",
          memoriesText,
          "</semantic_memories>",
        ].join("\n"),
      };

      return {
        injectedMessages: [injectedMessage],
      };
    } catch (err) {
      logger.warn("[MnemopiSource] Failed to recall memories", {
        error: String(err),
        task: base.taskDescription,
      });
      return {};
    }
  }
}
