/**
 * ProfileSource — Injects agent profile context from ProfileRegistry.
 *
 * Priority: 1.
 * Applies to: all phases, all agent roles.
 *
 * Uses ProfileRegistry.getPromptContext() to build an XML <agent_profile> block
 * containing identity, credit score, expertise, and violation history.
 */

import type { ContextSource, ContextFragment, AgentSpecLike, BuildContext } from "../context-pipeline";
import type { Chapter } from "../../core/state";
import type { ProfileRegistry } from "../../agent/agent-profile";

export class ProfileSource implements ContextSource {
  readonly name = "profile";
  readonly priority = 1;

  readonly #profileRegistry: ProfileRegistry;

  constructor(profileRegistry: ProfileRegistry) {
    this.#profileRegistry = profileRegistry;
  }

  appliesTo(_phase: Chapter, _agentRole: string): boolean {
    return true;
  }

  async build(spec: AgentSpecLike, _base: BuildContext): Promise<ContextFragment> {
    const profileCtx = this.#profileRegistry.getPromptContext(spec.id);
    if (!profileCtx) {
      return {};
    }

    return {
      systemPromptAddition: profileCtx,
    };
  }
}
