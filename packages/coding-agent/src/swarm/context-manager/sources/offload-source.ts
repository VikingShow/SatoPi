/**
 * OffloadSource — Injects offloaded context (MMD, experience) during Stage and Curtain phases.
 *
 * Priority: 5.
 * Applies to: "stage" and "curtain" phases.
 *
 * Uses the unified IOffloadManager interface from swarm/offload/.
 */

import type { ContextSource, ContextFragment, AgentSpecLike, BuildContext } from "../context-pipeline";
import type { Chapter } from "../../core/state";
import type { IOffloadManager } from "../../offload/offload-manager";
import { logger } from "@oh-my-pi/pi-utils";

// ============================================================================
// Source
// ============================================================================

export class OffloadSource implements ContextSource {
  readonly name = "offload";
  readonly priority = 5;

  readonly #offloadManager: IOffloadManager | null;

  constructor(offloadManager: IOffloadManager | null = null) {
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
      const mmdCtx = await this.#offloadManager.getMmdContext(spec.id, base.taskDescription);
      if (mmdCtx) {
        additions.push(mmdCtx);
      }
    } catch (err) {
      logger.warn("[OffloadSource] Failed to get MMD context", {
        error: String(err),
        agentId: spec.id,
      });
    }

    try {
      const expCtx = await this.#offloadManager.getExperienceContext(spec.id, base.taskDescription);
      if (expCtx) {
        additions.push(expCtx);
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
