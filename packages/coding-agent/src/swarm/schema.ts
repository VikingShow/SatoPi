// ============================================================================
// Raw YAML shape (snake_case, optional fields)
// ============================================================================

interface RawSwarmAgentConfig {
	role: string;
	task: string;
	extra_context?: string;
	reports_to?: string[];
	waits_for?: string[];
	model?: string;
	/** P1-5: Whitelist — only these tools are available to this agent. */
	allowed_tools?: string[];
	/** P1-5: Blacklist — these tools are blocked for this agent. */
	blocked_tools?: string[];
}

interface RawSwarmConfig {
	name: string;
	workspace: string;
	mode?: string;
	target_count?: number;
	model?: string;
	agents: Record<string, RawSwarmAgentConfig>;
}

// ============================================================================
// Normalized types (camelCase, defaults applied)
// ============================================================================

export type SwarmMode = "pipeline" | "parallel" | "sequential" | "loop";

export interface SwarmAgent {
	name: string;
	role: string;
	task: string;
	extraContext?: string;
	reportsTo: string[];
	waitsFor: string[];
	model?: string;
	/** P1-5: Whitelist — only these tools are available. When set, all other tools are blocked. */
	allowedTools?: string[];
	/** P1-5: Blacklist — these tools are blocked (config-as-constraint). */
	blockedTools?: string[];
}

export interface SwarmDefinition {
	name: string;
	workspace: string;
	mode: SwarmMode;
	targetCount: number;
	model?: string;
	agents: Map<string, SwarmAgent>;
	/** Preserves YAML declaration order for implicit pipeline sequencing. */
	agentOrder: string[];
	/** Loop-mode configuration (set when mode === "loop"). */
	loopConfig?: LoopSwarmConfig;
}

// ============================================================================
// Loop mode configuration (NEW)
// ============================================================================

export interface LoopSwarmConfig {
	/** Maximum review-retry iterations before escalating to human. Default: 5. */
	maxIterations: number;
	/** If true, rejected outputs trigger automatic retry without human input. */
	autoRetry: boolean;
	humanEscalation: boolean;
	/** Worker configuration. */
	workers: {
		/** Initial worker count (proposed by Cloner, confirmed by human). Default: 5. */
		initial: number;
		/** Minimum workers allowed during dynamic scaling. Default: 1. */
		min: number;
		/** Maximum workers allowed during dynamic scaling. Default: 12. */
		max: number;
		/**
		 * When true, the TaskComplexityAnalyzer evaluates plan.md before
		 * the loop starts and overrides `initial` and `cloners.count` with
		 * its recommendations (clamped to min/max). Default: false (opt-in).
		 */
		auto: boolean;
		/**
		 * Number of deliberation rounds within one iteration.
		 * Workers in each round see prior rounds' outputs and refine.
		 * 0 = unlimited — driven by roundsConvergenceThreshold + hard safety cap (10).
		 * Default: 5.
		 */
		maxRounds: number;
		/**
		 * Consecutive rounds with Jaccard similarity at or above this
		 * threshold trigger early convergence and end the worker rounds.
		 * Only meaningful when maxRounds > 1 or maxRounds = 0.
		 * Default: 3.
		 */
		roundsConvergenceThreshold: number;
		/**
		 * Prompt excerpt injected into workers after round 1,
		 * instructing them to cross-examine prior outputs. Handlebars template:
		 * `{{priorOutputs}}` contains the prior rounds' outputs.
		 */
		roundtablePrompt?: string;
		/**
		 * Per-worker wall-clock timeout in ms. When exceeded the agent is
		 * aborted and marked as CRASHED. Default 5 min. 0 = no limit.
		 */
		agentTimeoutMs?: number;
	};
	/** Reviewer election configuration. */
	reviewer: {
		/**
		 * Enable reviewer election before round 1+.
		 * Round 0 collects nominations; round 1+ has an elected reviewer.
		 * Default: true.
		 */
		enabled: boolean;
		/**
		 * Timeout in milliseconds for nomination phase. Workers must
		 * include `## Nomination` in their output within this window.
		 * Default: 0 (no timeout — collected at end of round).
		 */
		electionTimeoutMs: number;
	};
	/** Worker deliberation (debate) configuration. */
	debate: {
		/**
		 * Enable structured debate between workers after each round (round 1+).
		 * Workers challenge, rebut, and resolve each other's outputs.
		 * Default: true.
		 */
		enabled: boolean;
		/**
		 * Maximum deliberation sub-rounds (challenge → rebuttal → resolution).
		 * Default: 2.
		 */
		maxRounds: number;
	};
	/** Plan debate configuration (Before Loop phase). */
	planDebate: {
		/** Enable multi-cloner plan debate before execution. Default: true. */
		enabled: boolean;
		/** Number of cloner instances in the debate. Default: 2. */
		clonerCount: number;
		/** Maximum debate rounds. Default: 3. */
		maxRounds: number;
		/**
		 * Consecutive rounds with plan similarity >= 85% trigger early
		 * convergence and end the debate. Default: 2.
		 */
		convergenceThreshold: number;
	};
	/** Cloner configuration. */
	cloners: {
		/**
		 * Cloner count. Cloners are latent guardians — they only review
		 * when the worker swarm fails to converge internally.
		 * Default: min(3, workers.initial).
		 */
		count: number;
	};
	/**
	 * Convergence detection: stop the loop early when cloner findings
	 * are identical for this many consecutive iterations.
	 * 0 disables convergence detection (backward-compatible).
	 * Default: 2.
	 */
	convergenceThreshold: number;
	/**
	 * Per-iteration timeout in milliseconds. Workers or cloners that
	 * exceed this are aborted and the iteration continues to the next.
	 * Default: 300_000 (5 minutes). 0 disables timeout.
	 */
	iterationTimeoutMs: number;
	/**
	 * Enable cloner deliberation: when a review FAILs with split findings,
	 * cloners cross-examine each other's findings and re-vote.
	 * Default: true.
	 */
	enableDeliberation: boolean;
	/**
	 * Verification hook — run commands (tests, type-check, build) after loop
	 * completes. If blocking and any command fails, the loop continues to
	 * the next iteration instead of entering After Loop.
	 */
	verification?: VerificationConfig;
	/**
	 * Per-agent tool restrictions — config-as-constraint pattern.
	 * Keys are agent name patterns (e.g. "worker", "cloner", "socrates").
	 * Agents physically cannot use blocked tools.
	 */
	agentRestrictions?: Record<string, AgentToolRestriction>;
	/** P4-1: Lifecycle hook commands executed at pipeline events. */
	hooks?: HookConfig[];
	/** Git-based snapshot / rollback configuration for loop iterations. */
	snapshot?: LoopSnapshotConfig;
	/** P4: Mnemopi semantic recall configuration. */
	mnemopi?: MnemopiConfig;
	/** P5.5: Offload pipeline + Mermaid context graph configuration. */
	offload?: OffloadConfig;
}

// ============================================================================
// Git-based snapshot / rollback config
// ============================================================================

/**
 * Git-based snapshot / rollback configuration for loop iterations.
 * When enabled, the loop creates a git commit before each iteration
 * and can roll back the workspace on failure.
 */
export interface LoopSnapshotConfig {
	/** Enable automatic git snapshots before each iteration. Default false. */
	enabled?: boolean;
	/** Auto-rollback workspace on iteration crash or timeout. Default false. */
	rollbackOnError?: boolean;
	/** Auto-rollback on blocking verification failure. Default false. */
	rollbackOnVerificationFailure?: boolean;
	/** Maximum snapshot history to keep. Older ones get cleaned. Default 5. */
	maxSnapshots?: number;
}

// ============================================================================
// P4-1: YAML-configured pipeline hooks
// ============================================================================

export interface HookConfig {
	/** Pipeline lifecycle event name (e.g. "beforeIteration", "afterWave"). */
	event: string;
	/** Shell command to execute. Receives context JSON on stdin. */
	command?: string;
	/** Inline script (executed via `bash -c`). */
	script?: string;
	/** Error handling: "continue" (log + continue), "skip" (skip iteration/wave), "abort" (stop pipeline). */
	onError?: "continue" | "skip" | "abort";
}

/**
 * Parse raw hook entries from YAML into HookConfig array.
 * Validates event names and ensures at least one of command/script is set.
 */
export function parseHooksConfig(raw: Record<string, unknown>[] | undefined): HookConfig[] | undefined {
	if (!raw || !Array.isArray(raw)) return undefined;
	const validEvents = new Set([
		"beforePipeline",
		"beforeIteration",
		"afterIteration",
		"beforeWave",
		"afterWave",
		"afterPipeline",
	]);
	const hooks: HookConfig[] = [];
	for (const entry of raw) {
		const event = String(entry.event ?? "");
		if (!validEvents.has(event)) continue;
		const command = typeof entry.command === "string" ? entry.command.trim() : undefined;
		const script = typeof entry.script === "string" ? entry.script.trim() : undefined;
		if (!command && !script) continue;
		const onError = (entry.on_error ?? entry.onError ?? "continue") as HookConfig["onError"];
		if (onError !== "continue" && onError !== "skip" && onError !== "abort") continue;
		hooks.push({ event, command, script, onError });
	}
	return hooks.length > 0 ? hooks : undefined;
}

/**
 * Verification configuration for post-loop testing.
 */
export interface VerificationConfig {
	/** Shell commands to run (e.g. ["bun test", "tsc --noEmit"]). */
	commands: string[];
	/** If true, failure rolls back to running for another iteration. */
	blocking: boolean;
}

/**
 * Agent tool restriction — config-as-constraint pattern.
 * Either whitelist (allowed) or blacklist (blocked) can be used.
 */
export interface AgentToolRestriction {
	/** Whitelist — only these tools are available. */
	allowed?: string[];
	/** Blacklist — these tools are blocked. */
	blocked?: string[];
}

// ============================================================================
// P4: Mnemopi semantic recall config
// ============================================================================

/** Semantic recall configuration powered by mnemopi. */
export interface MnemopiConfig {
	/** Enable semantic recall across the swarm loop. Default false. */
	enabled?: boolean;
	/** Recall top-K. Default 5. */
	topK?: number;
	/** Deduplicate injections across iterations. Default true. */
	deduplicate?: boolean;
	/** Auto-store threshold: only outcomes with score >= this value are persisted. Default 5. */
	autoStoreThreshold?: number;
}

// ============================================================================
// P5.5: Offload pipeline + Mermaid context graph config
// ============================================================================

/**
 * Offload pipeline configuration for L1→L1.5→L2→L3 context offload
 * and Mermaid context graph injection into Worker/Cloner/LoopController.
 */
export interface OffloadConfig {
	/** Enable the full offload pipeline. Default false. */
	enabled?: boolean;
	/** L1 trigger threshold: flush pending entries when count >= this. Default 4. */
	l1TriggerThreshold?: number;
	/** L2 trigger threshold: trigger L2 when null-phase entries >= this. Default 3. */
	l2NullThreshold?: number;
	/** L2 timeout (seconds): force L2 when no L2 ran within this window. Default 120. */
	l2TimeoutSeconds?: number;
	/** Inject Mermaid context graph into agent prompts. Default true. */
	injectMermaid?: boolean;
}

/** Normalise raw loop YAML fields into LoopSwarmConfig with defaults. */
export function resolveLoopConfig(raw: Record<string, unknown>): LoopSwarmConfig {
	const workersRaw = (raw.workers as Record<string, unknown>) ?? {};
	const clonersRaw = (raw.cloners as Record<string, number>) ?? {};
	const workerInitial = (workersRaw.initial as number) ?? 5;
	return {
		maxIterations: (raw.max_iterations as number) ?? 5,
		planDebate: {
			enabled: ((raw.plan_debate as Record<string, unknown>)?.enabled as boolean) ?? true,
			clonerCount: ((raw.plan_debate as Record<string, unknown>)?.cloner_count as number) ?? 2,
			maxRounds: ((raw.plan_debate as Record<string, unknown>)?.max_rounds as number) ?? 3,
			convergenceThreshold: ((raw.plan_debate as Record<string, unknown>)?.convergence_threshold as number) ?? 2,
		},
		autoRetry: (raw.auto_retry as boolean) ?? true,
		humanEscalation: (raw.human_escalation as boolean) ?? true,
		workers: {
			initial: workerInitial,
			min: (workersRaw.min as number) ?? 1,
			max: (workersRaw.max as number) ?? 12,
			auto: (workersRaw.auto as boolean) ?? false,
			maxRounds: (workersRaw.max_rounds as number) ?? 5,
			roundsConvergenceThreshold: (workersRaw.rounds_convergence_threshold as number) ?? 3,
			roundtablePrompt: workersRaw.roundtable_prompt as string | undefined,
			agentTimeoutMs: workersRaw.agent_timeout_ms as number | undefined,
		},
		reviewer: {
			enabled: ((raw.reviewer as Record<string, unknown>)?.enabled as boolean) ?? true,
			electionTimeoutMs: ((raw.reviewer as Record<string, unknown>)?.election_timeout_ms as number) ?? 0,
		},
		debate: {
			enabled: ((raw.debate as Record<string, unknown>)?.enabled as boolean) ?? true,
			maxRounds: ((raw.debate as Record<string, unknown>)?.max_rounds as number) ?? 2,
		},
		cloners: {
			count: clonersRaw.count ?? Math.min(3, workerInitial),
		},
		convergenceThreshold: (raw.convergence_threshold as number) ?? 2,
		iterationTimeoutMs: (raw.iteration_timeout_ms as number) ?? 300_000,
		enableDeliberation: (raw.enable_deliberation as boolean) ?? true,
		verification: parseVerificationConfig(raw.verification as Record<string, unknown> | undefined),
		agentRestrictions: parseAgentRestrictions(
			raw.agent_restrictions as Record<string, Record<string, unknown>> | undefined,
		),
		// P4-1: YAML-configured lifecycle hooks.
		hooks: parseHooksConfig(raw.hooks as Record<string, unknown>[] | undefined),
		// Snapshot / rollback config.
		snapshot: parseSnapshotConfig(raw.snapshot as Record<string, unknown> | undefined),
		// P4: Mnemopi semantic recall (opt-in, disabled by default).
		mnemopi: parseMnemopiConfig(raw.mnemopi as Record<string, unknown> | undefined),
		// P5.5: Offload pipeline (opt-in, disabled by default).
		offload: parseOffloadConfig(raw.offload as Record<string, unknown> | undefined),
	};
}

// ============================================================================
// P4: Parse Mnemopi config from YAML
// ============================================================================

function parseMnemopiConfig(raw: Record<string, unknown> | undefined): MnemopiConfig | undefined {
	if (!raw) return undefined;
	return {
		enabled: (raw.enabled as boolean) ?? false,
		topK: (raw.top_k as number) ?? 5,
		deduplicate: (raw.deduplicate as boolean) ?? true,
		autoStoreThreshold: (raw.auto_store_threshold as number) ?? 5,
	};
}

// ============================================================================
// P5.5: Parse Offload config from YAML
// ============================================================================

function parseOffloadConfig(raw: Record<string, unknown> | undefined): OffloadConfig | undefined {
	if (!raw) return undefined;
	return {
		enabled: (raw.enabled as boolean) ?? false,
		l1TriggerThreshold: (raw.l1_trigger_threshold as number) ?? 4,
		l2NullThreshold: (raw.l2_null_threshold as number) ?? 3,
		l2TimeoutSeconds: (raw.l2_timeout_seconds as number) ?? 120,
		injectMermaid: (raw.inject_mermaid as boolean) ?? true,
	};
}

function parseSnapshotConfig(raw: Record<string, unknown> | undefined): LoopSnapshotConfig | undefined {
	if (!raw) return undefined;
	// If the entire block is present but enabled isn't true, still return
	// undefined — snapshot is disabled by default.
	const enabled = raw.enabled as boolean | undefined;
	if (enabled !== true) return undefined;
	return {
		enabled: true,
		rollbackOnError: (raw.rollback_on_error as boolean) ?? false,
		rollbackOnVerificationFailure: (raw.rollback_on_verification_failure as boolean) ?? false,
		maxSnapshots: (raw.max_snapshots as number) ?? 5,
	};
}

function parseVerificationConfig(raw: Record<string, unknown> | undefined): VerificationConfig | undefined {
	if (!raw) return undefined;
	const commands = raw.commands as string[] | undefined;
	if (!commands || !Array.isArray(commands) || commands.length === 0) return undefined;
	return {
		commands: commands.map(c => String(c)),
		blocking: (raw.blocking as boolean) ?? true,
	};
}

function parseAgentRestrictions(
	raw: Record<string, Record<string, unknown>> | undefined,
): Record<string, AgentToolRestriction> | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const result: Record<string, AgentToolRestriction> = {};
	for (const [agentName, config] of Object.entries(raw)) {
		if (!config || typeof config !== "object") continue;
		const restriction: AgentToolRestriction = {};
		if (Array.isArray(config.allowed)) {
			restriction.allowed = (config.allowed as unknown[]).map(String);
		}
		if (Array.isArray(config.blocked)) {
			restriction.blocked = (config.blocked as unknown[]).map(String);
		}
		if (restriction.allowed || restriction.blocked) {
			result[agentName] = restriction;
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

// ============================================================================
// Parsing
// ============================================================================

const VALID_MODES = new Set<string>(["pipeline", "parallel", "sequential", "loop"]);
const VALID_SWARM_NAME = /^[a-zA-Z0-9._-]+$/;

export function parseSwarmYaml(content: string): SwarmDefinition {
	const raw = Bun.YAML.parse(content) as { swarm?: RawSwarmConfig } | null;
	if (!raw?.swarm) {
		throw new Error("YAML must have a top-level 'swarm' key");
	}
	const swarm = raw.swarm;

	if (!swarm.name || typeof swarm.name !== "string") {
		throw new Error("swarm.name is required and must be a string");
	}
	if (!VALID_SWARM_NAME.test(swarm.name)) {
		throw new Error("swarm.name may only contain letters, numbers, dot, underscore, and dash");
	}
	if (!swarm.workspace || typeof swarm.workspace !== "string") {
		throw new Error("swarm.workspace is required and must be a string");
	}
	const mode = swarm.mode ?? "sequential";
	if (!swarm.agents || typeof swarm.agents !== "object") {
		throw new Error("swarm.agents must be an object");
	}
	if (mode !== "loop" && Object.keys(swarm.agents).length === 0) {
		throw new Error("swarm.agents must contain at least one agent (empty allowed for loop mode)");
	}

	if (!VALID_MODES.has(mode)) {
		throw new Error(`Invalid mode '${mode}'. Must be one of: ${[...VALID_MODES].join(", ")}`);
	}

	const agentOrder: string[] = [];
	const agents = new Map<string, SwarmAgent>();

	for (const [name, config] of Object.entries(swarm.agents)) {
		if (!config.role || typeof config.role !== "string") {
			throw new Error(`Agent '${name}': 'role' is required`);
		}
		if (!config.task || typeof config.task !== "string") {
			throw new Error(`Agent '${name}': 'task' is required`);
		}

		agentOrder.push(name);
		agents.set(name, {
			name,
			role: config.role,
			task: config.task.trim(),
			extraContext: config.extra_context?.trim(),
			reportsTo: Array.isArray(config.reports_to) ? config.reports_to : [],
			model: typeof config.model === "string" ? config.model.trim() : undefined,
			waitsFor: Array.isArray(config.waits_for) ? config.waits_for : [],
			// P1-5: Tool restrictions per agent.
			allowedTools: Array.isArray(config.allowed_tools)
				? config.allowed_tools.map(t => t.trim()).filter(Boolean)
				: undefined,
			blockedTools: Array.isArray(config.blocked_tools)
				? config.blocked_tools.map(t => t.trim()).filter(Boolean)
				: undefined,
		});
	}

	// Resolve loop config when mode is "loop"
	const loopConfig = mode === "loop" ? resolveLoopConfig(raw.swarm as unknown as Record<string, unknown>) : undefined;

	return {
		name: swarm.name,
		workspace: swarm.workspace,
		mode: mode as SwarmMode,
		// targetCount is the pipeline's internal iteration count (1 per loop iteration).
		// loopConfig.maxIterations controls the outer review-gate loop.
		// They are separate — do NOT conflate them.
		targetCount: swarm.target_count ?? 1,
		model: typeof swarm.model === "string" ? swarm.model.trim() : undefined,
		agents,
		agentOrder,
		loopConfig,
	};
}

// ============================================================================
// Validation (semantic — references, constraints)
// ============================================================================

export function validateSwarmDefinition(def: SwarmDefinition): string[] {
	const errors: string[] = [];
	const agentNames = new Set(def.agents.keys());

	if (def.model !== undefined && def.model.length === 0) {
		errors.push("swarm.model must not be empty when provided");
	}
	for (const [name, agent] of def.agents) {
		for (const dep of agent.waitsFor) {
			if (!agentNames.has(dep)) {
				errors.push(`Agent '${name}' waits_for unknown agent '${dep}'`);
			}
			if (dep === name) {
				errors.push(`Agent '${name}' cannot wait for itself`);
			}
		}
		for (const target of agent.reportsTo) {
			if (!agentNames.has(target)) {
				errors.push(`Agent '${name}' reports_to unknown agent '${target}'`);
			}
			if (target === name) {
				errors.push(`Agent '${name}' cannot report to itself`);
			}
		}
	}

	if (def.targetCount < 1) {
		errors.push("target_count must be at least 1");
	}
	if (def.loopConfig) {
		if (def.loopConfig.workers.maxRounds < 0) {
			errors.push("workers.max_rounds must be >= 0 (0 = unlimited, convergence-driven)");
		}
	}
	if (def.mode !== "pipeline" && def.mode !== "loop" && def.targetCount !== 1) {
		errors.push("target_count is only supported in pipeline and loop mode");
	}

	return errors;
}
