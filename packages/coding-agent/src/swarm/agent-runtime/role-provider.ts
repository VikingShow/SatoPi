/**
 * role-provider.ts — Resolves an AgentSpec's role into a concrete ResolvedRole.
 *
 * Queries the RoleAssetManager for library-based roles, uses inline
 * definitions when provided, and falls back to a sensible default for
 * unknown or unapproved roles.
 *
 * Part of the AgentRuntime system (Phase 3A).
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { RoleAsset, RoleAssetManager } from "../../agent/role-asset";
import type { AgentSpec } from "./agent-spec";

// ============================================================================
// Types
// ============================================================================

/**
 * The resolved role — concrete prompt, tools, and guidelines
 * ready to feed into the AgentLauncher.
 */
export interface ResolvedRole {
	/** System prompt injected into the agent's initial context. */
	systemPrompt: string;

	/** Behavioural guidelines appended to the system prompt. */
	guidelines: string[];

	/** Tool names this role has access to. */
	tools: string[];
}

// ============================================================================
// RoleProvider
// ============================================================================

/**
 * Resolves AgentSpec.role → ResolvedRole.
 *
 * Resolution order:
 * 1. Library: Query RoleAssetManager.get(spec.role). If found and approved, use it.
 * 2. Inline: Use spec.inline directly.
 * 3. Default: Generate a minimal role from the role name.
 */
export class RoleProvider {
	constructor(private roleAssetManager: RoleAssetManager) {}

	/**
	 * Resolve an AgentSpec to a concrete ResolvedRole.
	 */
	async resolve(spec: AgentSpec): Promise<ResolvedRole> {
		// 1. Try the role library
		if (spec.roleSource === "library") {
			const role = await this.resolveFromLibrary(spec.role);
			if (role) return role;
			logger.warn("[RoleProvider] Library role not found or not approved, falling back", {
				role: spec.role,
			});
		}

		// 2. Use inline definition
		if (spec.roleSource === "inline" && spec.inline) {
			return {
				systemPrompt: spec.inline.systemPrompt,
				guidelines: [],
				tools: spec.inline.tools,
			};
		}

		// 3. "profile" source — not yet implemented; fall through to default
		if (spec.roleSource === "profile") {
			logger.warn("[RoleProvider] Profile-based roles not yet implemented, using default", {
				role: spec.role,
			});
		}

		// 4. Default fallback
		return {
			systemPrompt: `You are a ${spec.role} agent in the SatoPi swarm system. Complete your assigned task thoroughly and report your results.`,
			guidelines: [],
			tools: ["read", "grep", "glob"],
		};
	}

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	/**
	 * Try to resolve a role from the library.
	 * Returns null if the role is not found or not approved.
	 */
	private async resolveFromLibrary(roleName: string): Promise<ResolvedRole | null> {
		try {
			const role: RoleAsset | null = await this.roleAssetManager.get(roleName);

			if (!role) return null;
			if (role.status !== "approved") return null;

			return {
				systemPrompt: role.prompts.system,
				guidelines: role.prompts.guidelines ?? [],
				tools: role.tools ?? [],
			};
		} catch (err) {
			logger.warn("[RoleProvider] Error resolving role from library", {
				role: roleName,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		}
	}
}
