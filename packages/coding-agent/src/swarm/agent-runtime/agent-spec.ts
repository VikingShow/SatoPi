/**
 * agent-spec.ts — Declarative specification for spawning a swarm agent.
 *
 * Part of the AgentRuntime system (Phase 3A of the swarm v3 unified architecture).
 * An AgentSpec describes WHAT to spawn — the AgentRuntime handles HOW.
 *
 * @deprecated Use AgentSessionOptions directly with AgentRuntime.spawn().
 */
import type { Chapter } from "../core/state";

/**
 * Common fields shared by all AgentSpec variants.
 */
interface AgentSpecBase {
	/** Unique agent identifier (e.g. "planner", "agent-1", "reporter"). */
	id: string;

	/** Role name to resolve from the role library (e.g. "planner", "backend", "reviewer"). */
	role: string;

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
	phase?: Chapter;

	/**
	 * Optional tool names to inject into the agent session.
	 *
	 * Merged with tools from role resolution and context assembly.
	 * Used by callers to inject tooling-strategy-specific tools
	 * (e.g. swift: quick-task-complete; persistent: session-save).
	 */
	tools?: string[];
}
/** @deprecated Use AgentSessionOptions directly. */
export interface AgentSpecLibrary extends AgentSpecBase {
	roleSource: "library";
	/** Optional persistent agent profile binding (not required for library roles). */
	profileId?: string;
}

/** @deprecated Use AgentSessionOptions directly. */
export interface AgentSpecProfile extends AgentSpecBase {
	roleSource: "profile";
	/** Required persistent agent profile ID for profile-based role resolution. */
	profileId: string;
}

/** @deprecated Use AgentSessionOptions directly. */
export interface AgentSpecInline extends AgentSpecBase {
	roleSource: "inline";
	/** Inline role definition — required when roleSource is "inline". */
	inline: {
		systemPrompt: string;
		tools: string[];
	};
	/** Optional persistent agent profile binding. */
	profileId?: string;
}

/**
 * Declarative specification for spawning an agent.
 *
 * All phases (script, stage, curtain) use this discriminated union.
 * The AgentRuntime resolves the role, assembles context, builds
 * AgentLoopConfig, and launches the SatoPi Agent instance.
 *
 * @deprecated Use AgentSessionOptions directly with AgentRuntime.spawn().
 */
export type AgentSpec = AgentSpecLibrary | AgentSpecProfile | AgentSpecInline;
