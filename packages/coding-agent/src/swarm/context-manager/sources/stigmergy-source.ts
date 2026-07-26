/**
 * StigmergySource — Injects stigmergic environment signals from MarkEnvironment.
 *
 * Priority: 4.
 * Applies to: "stage" phase only — during active work, agents need awareness of
 *   locks, warnings, signals, and artifacts placed by peers.
 *
 * Queries MarkEnvironment.getContextForAgent() which returns formatted XML
 * describing active marks (warnings, locks, signals, artifacts) that the agent
 * should be aware of.
 */

import type { ContextSource, ContextFragment, AgentSpecLike, BuildContext } from "../context-pipeline";
import type { Chapter } from "../../core/state";
import type { MarkEnvironment } from "../../../coordination/mark-environment"

export class StigmergySource implements ContextSource {
  readonly name = "stigmergy";
  readonly priority = 4;

  readonly #markEnv: MarkEnvironment;

  constructor(markEnv: MarkEnvironment) {
    this.#markEnv = markEnv;
  }

  appliesTo(phase: Chapter, _agentRole: string): boolean {
    return phase === "stage";
  }

  async build(spec: AgentSpecLike, _base: BuildContext): Promise<ContextFragment> {
    const contextText = this.#markEnv.getContextForAgent(spec.id);
    if (!contextText) {
      return {};
    }

    return {
      systemPromptAddition: contextText,
    };
  }
}
