/**
 * OffloadSource — Injects offloaded context (MMD, experience) during Stage and Curtain phases.
 *
 * Priority: 5.
 * Applies to: "stage" and "curtain" phases.
 *
 * OffloadManager does not exist yet — this source uses a placeholder interface.
 * When OffloadManager is implemented, update the constructor to accept it.
 */

import type { ContextSource, ContextFragment, AgentSpecLike, BuildContext } from "../context-pipeline";
import type { Chapter } from "../../core/state";
import { logger } from "@oh-my-pi/pi-utils";

// ============================================================================
// Placeholder interface — replace with real OffloadManager when available
// ============================================================================

/**
 * Placeholder interface for OffloadManager.
 * When the real OffloadManager is implemented, it should provide:
 * - MMD (Mermaid diagram) context for architectural awareness
 * - Experience context specific to the current task
 */
export interface OffloadManagerPlaceholder {
  /** Get MMD context relevant to the agent's current task. */
  getMmdContext?(agentId: string, taskDescription: string): Promise<string | null>;
  /** Get experience context from offloaded conversation history. */
  getExperienceContext?(agentId: string, taskDescription: string): Promise<string | null>;
}

// ============================================================================
// Source
// ============================================================================

export class OffloadSource implements ContextSource {
  readonly name = "offload";
  readonly priority = 5;

  readonly #offloadManager: OffloadManagerPlaceholder | null;

  constructor(offloadManager: OffloadManagerPlaceholder | null = null) {
    this.#offloadManager = offloadManager;
  }

  appliesTo(phase: Chapter, _agentRole: string): boolean {
    return phase === "stage" || phase === "curtain";
  }

  async build(spec: AgentSpecLike, base: BuildContext): Promise<ContextFragment> {
    if (!this.#offloadManager) {
      return {};
    }

    const additions: string[] = [];

    try {
      if (this.#offloadManager.getMmdContext) {
        const mmdCtx = await this.#offloadManager.getMmdContext(spec.id, base.taskDescription);
        if (mmdCtx) {
          additions.push(mmdCtx);
        }
      }
    } catch (err) {
      logger.warn("[OffloadSource] Failed to get MMD context", {
        error: String(err),
        agentId: spec.id,
      });
    }

    try {
      if (this.#offloadManager.getExperienceContext) {
        const expCtx = await this.#offloadManager.getExperienceContext(spec.id, base.taskDescription);
        if (expCtx) {
          additions.push(expCtx);
        }
      }
    } catch (err) {
      logger.warn("[OffloadSource] Failed to get experience context", {
        error: String(err),
        agentId: spec.id,
      });
    }

    if (additions.length === 0) {
      return {};
    }

    return {
      systemPromptAddition: additions.join("\n\n"),
    };
  }
}
