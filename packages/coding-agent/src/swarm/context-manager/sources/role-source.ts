/**
 * RoleSource — Injects role definition (system prompt + tools) from RoleAssetManager.
 *
 * Priority: 0 (highest — runs first, establishes the agent's identity).
 * Applies to: all phases, all agent roles.
 */

import type { ContextSource, ContextFragment, AgentSpecLike, BuildContext } from "../context-pipeline";
import type { Chapter } from "../../core/state";
import type { RoleAssetManager } from "../../agent/role-asset";

export class RoleSource implements ContextSource {
  readonly name = "role";
  readonly priority = 0;

  readonly #roleAssetManager: RoleAssetManager;

  constructor(roleAssetManager: RoleAssetManager) {
    this.#roleAssetManager = roleAssetManager;
  }

  appliesTo(_phase: Chapter, _agentRole: string): boolean {
    return true;
  }

  async build(spec: AgentSpecLike, _base: BuildContext): Promise<ContextFragment> {
    const role = await this.#roleAssetManager.get(spec.role);
    if (!role) {
      return {};
    }

    const fragment: ContextFragment = {};

    // Only inject tools — system prompt is resolved by RoleProvider
    if (role.tools && role.tools.length > 0) {
      fragment.tools = [...role.tools];
    }

    return fragment;
  }
}
