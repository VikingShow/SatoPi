/**
 * role-provider.ts — Resolves an AgentSpec's role into a concrete ResolvedRole.
 *
 * Queries the RoleAssetManager for library-based roles, uses inline
 * definitions when provided, resolves profile-based roles from AgentProfile
 * data, and falls back to a sensible default for unknown or unapproved roles.
 *
 * Moved from swarm/agent-runtime/ to agent/ (Phase 3 — Wave 1 native swarm refactor).
 */

import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { AgentSpec } from "../swarm/agent-runtime/agent-spec";
import roleFallbackPrompt from "../swarm/prompts/role-fallback.md" with { type: "text" };
import roleProfilePrompt from "../swarm/prompts/role-profile.md" with { type: "text" };
import type { AgentProfile, ProfileRegistry } from "./agent-profile";
import type { RoleAsset, RoleAssetManager } from "./role-asset";

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
// Domain → Tool Mapping
// ============================================================================

/**
 * Maps expertise domains to tool names.
 * Higher-proficiency domains select corresponding tools for profile-based roles.
 */
const DOMAIN_TOOLS: Record<string, string[]> = {
	"code-analysis": ["read", "grep", "glob", "ast_grep"],
	"code-editing": ["edit", "write", "ast_edit"],
	refactoring: ["edit", "ast_edit", "grep", "glob"],
	debugging: ["debug", "bash", "launch", "grep"],
	testing: ["browser", "launch", "bash", "debug"],
	scripting: ["bash", "eval", "launch"],
	automation: ["bash", "launch", "task", "eval"],
	orchestration: ["task", "agent_invoke", "irc", "job"],
	swarm: ["task", "agent_invoke", "irc", "job"],
	coordination: ["irc", "job", "task"],
	communication: ["irc"],
	research: ["web_search", "read", "grep"],
	"ui-development": ["browser", "edit", "write"],
	typescript: ["read", "edit", "write", "ast_grep", "ast_edit", "grep", "glob"],
	javascript: ["read", "edit", "write", "ast_grep", "ast_edit", "grep", "glob"],
	python: ["read", "edit", "write", "bash", "eval"],
	documentation: ["read", "write", "grep"],
	review: ["read", "grep", "glob", "ast_grep"],
	planning: ["read", "grep", "glob", "task"],
};

/** Default tools when no domain match is found. */
const DEFAULT_PROFILE_TOOLS = ["read", "grep", "glob"];

// ============================================================================
// RoleProvider
// ============================================================================

/**
 * Resolves AgentSpec.role → ResolvedRole.
 *
 * Resolution order:
 * 1. Library: Query RoleAssetManager.get(spec.role). If found and approved, use it.
 * 2. Inline: Use spec.inline directly.
 * 3. Profile: Resolve from AgentProfile data via resolveFromProfile().
 * 4. Default: Generate a minimal role from the role name.
 */
export class RoleProvider {
	#roleAssetManager: RoleAssetManager;
	#profileRegistry?: ProfileRegistry;

	constructor(roleAssetManager: RoleAssetManager, profileRegistry?: ProfileRegistry) {
		this.#roleAssetManager = roleAssetManager;
		this.#profileRegistry = profileRegistry;
	}

	/**
	 * Resolve an AgentSpec to a concrete ResolvedRole.
	 */
	async resolve(spec: AgentSpec): Promise<ResolvedRole> {
		// 1. Try the role library
		if (spec.roleSource === "library") {
			const role = await this.#resolveFromLibrary(spec.role);
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

		// 3. Profile-based role resolution
		if (spec.roleSource === "profile") {
			const profile = this.#resolveProfile(spec);
			if (profile) return this.resolveFromProfile(profile);

			logger.warn("[RoleProvider] Profile not found for profile-based agent, using default", {
				role: spec.role,
				profileId: "profileId" in spec ? spec.profileId : undefined,
			});
		}

		// 4. Default fallback
		return {
			systemPrompt: prompt.render(roleFallbackPrompt, { role: spec.role }),
			guidelines: [],
			tools: ["read", "grep", "glob"],
		};
	}

	/**
	 * Resolve a role from an AgentProfile's persistent identity data.
	 *
	 * Builds a system prompt from the profile's name, archetype, domains,
	 * credit score, success rate, and history summaries. Selects tools based
	 * on the profile's highest-proficiency domains.
	 */
	resolveFromProfile(profile: AgentProfile): ResolvedRole {
		const { identity, expertise, credit, offloadRefs } = profile;

		// Build domain list sorted by proficiency (highest first)
		const domains = [...expertise.domains].sort(
			(a, b) => (expertise.proficiency[b] ?? 0) - (expertise.proficiency[a] ?? 0),
		);
		const topDomains = domains.slice(0, 5);

		// Build history summaries from offload L1 refs
		const historyLines = offloadRefs.l1History
			.slice(-5)
			.map(ref => `- ${ref.timestamp}: ${ref.taskCall} (score: ${ref.score})`);
		const history = historyLines.length > 0 ? historyLines.join("\n") : "(no prior task history)";

		// Resolve tools from highest-proficiency domains
		const tools = this.#selectToolsFromDomains(domains, expertise.proficiency);

		const systemPrompt = prompt.render(roleProfilePrompt, {
			name: identity.name,
			archetype: identity.archetype,
			domains: topDomains.join(", "),
			score: String(credit.score),
			successRate: `${Math.round(credit.successRate * 100)}%`,
			history,
		});

		return {
			systemPrompt,
			guidelines: [
				`You are ${identity.name}, a ${identity.archetype} agent.`,
				`Credit score: ${credit.score}/100 (success rate: ${Math.round(credit.successRate * 100)}%).`,
				`Expert in: ${topDomains.join(", ")}.`,
				`Leverage your domain expertise when selecting tools and approaches.`,
			],
			tools,
		};
	}

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	/**
	 * Look up a profile for the given spec.
	 * Returns undefined when no registry is configured or the profile is missing.
	 */
	#resolveProfile(spec: AgentSpec): AgentProfile | undefined {
		if (!this.#profileRegistry) return undefined;
		// profileId is required in the discriminated union for roleSource "profile"
		const profileId = "profileId" in spec ? spec.profileId : undefined;
		if (!profileId) return undefined;
		return this.#profileRegistry.get(profileId);
	}

	/**
	 * Select tools based on domain proficiency.
	 * Collects tools from each domain, deduplicates, and returns the union.
	 * Falls back to a minimal set when no domains match.
	 */
	#selectToolsFromDomains(domains: string[], proficiency: Record<string, number>): string[] {
		const toolSet = new Set<string>();
		// Always include basic read tools
		toolSet.add("read");
		toolSet.add("grep");
		toolSet.add("glob");

		// Sort domains by proficiency and collect tools from the top ones
		const rankedDomains = [...domains]
			.filter(d => (proficiency[d] ?? 0) > 0.3)
			.sort((a, b) => (proficiency[b] ?? 0) - (proficiency[a] ?? 0));

		for (const domain of rankedDomains.slice(0, 4)) {
			const domainTools = DOMAIN_TOOLS[domain];
			if (domainTools) {
				for (const tool of domainTools) {
					toolSet.add(tool);
				}
			}
		}

		// If no domain tools were found, add defaults
		if (toolSet.size <= 3) {
			for (const tool of DEFAULT_PROFILE_TOOLS) {
				toolSet.add(tool);
			}
		}

		return [...toolSet];
	}

	/**
	 * Try to resolve a role from the library.
	 * Returns null if the role is not found or not approved.
	 */
	async #resolveFromLibrary(roleName: string): Promise<ResolvedRole | null> {
		try {
			const role: RoleAsset | null = await this.#roleAssetManager.get(roleName);

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
