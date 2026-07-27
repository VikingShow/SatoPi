/**
 * agent-spec.ts — Declarative specification for spawning a swarm agent.
 *
 * Part of the AgentRuntime system (Phase 3A of the swarm v3 unified architecture).
 * An AgentSpec describes WHAT to spawn — the AgentRuntime handles HOW.
 */

/**
 * Declarative specification for spawning an agent.
 *
 * All phases (script, stage, curtain) use this single spec type.
 * The AgentRuntime resolves the role, assembles context, builds
 * AgentLoopConfig, and launches the SatoPi Agent instance.
 */
export interface AgentSpec {
	/** Unique agent identifier (e.g. "planner", "agent-1", "reporter"). */
	id: string;

	/** Role name to resolve from the role library (e.g. "planner", "backend", "reviewer"). */
	role: string;

	/**
	 * Where the role definition comes from.
	 *
	 * - "library": Query RoleAssetManager for an approved role asset.
	 * - "profile": Query agent profiles (future; falls back to default for now).
	 * - "inline": Use the inline systemPrompt and tools directly.
	 */
	roleSource: "library" | "profile" | "inline";

	/** Inline role definition — only used when roleSource is "inline". */
	inline?: {
		systemPrompt: string;
		tools: string[];
	};

	/** Human-readable task description for this agent. */
	task: string;

	/** Optional model preference hint for model resolution. */
	modelPreference?: "cheapest" | "smartest" | "role-default";

	/**
	 * Workflow phase this agent is spawned in.
	 *
	 * When set, spawnOne() uses this as BuildContext.phase instead of the
	 * hardcoded "stage" fallback, so phase-filtered context sources like
	 * ExperienceSource (applies only to "script"/"script-debate") fire
	 * correctly. When omitted, falls back to "stage" for backward
	 * compatibility.
	 */
	phase?: import("../core/state").Chapter;

	/**
	 * Links this spec to a persistent agent identity in the AgentRegistry.
	 * When set, the AgentRuntime associates the spawned agent with an existing
	 * profile so its state (callbacks, status) can be tracked across lifetime events.
	 */
	profileId?: string;
}
