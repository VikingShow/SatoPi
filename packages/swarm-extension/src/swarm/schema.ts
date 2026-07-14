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
	mode: "loop";
	/** Maximum review-retry iterations before escalating to human. Default: 5. */
	maxIterations: number;
	/** How review verdicts are tallied. "atropos_veto" = Atropos veto OR unified fail. */
	reviewGate: "atropos_veto";
	/** If true, rejected outputs trigger automatic retry without human input. */
	autoRetry: boolean;
	/** If true, escalate to human when maxIterations exhausted. */
	humanEscalation: boolean;
	/** Timeouts for each roundtable phase (ms). */
	roundtable: {
		proposeTimeout: number;
		debateTimeout: number;
		voteTimeout: number;
	};
	reviewers: {
		/** Core reviewer IDs — always present, 3 required. */
		core: string[];
		/** Optional reviewer pool — drawn by tag-matching. */
		pool: string[];
		/** Max optional reviewers per iteration. Default: 4. */
		maxOptional: number;
		/** Task feature tag → reviewer id mapping. */
		tagMapping: Record<string, string>;
	};
}

/** Normalise raw loop YAML fields into LoopSwarmConfig with defaults. */
export function resolveLoopConfig(raw: Record<string, unknown>): LoopSwarmConfig {
	return {
		mode: "loop",
		maxIterations: (raw.max_iterations as number) ?? 5,
		reviewGate: (raw.review_gate as LoopSwarmConfig["reviewGate"]) ?? "atropos_veto",
		autoRetry: (raw.auto_retry as boolean) ?? true,
		humanEscalation: (raw.human_escalation as boolean) ?? true,
		roundtable: {
			proposeTimeout: (raw.roundtable as Record<string, number>)?.propose_timeout ?? 60_000,
			debateTimeout: (raw.roundtable as Record<string, number>)?.debate_timeout ?? 120_000,
			voteTimeout: (raw.roundtable as Record<string, number>)?.vote_timeout ?? 30_000,
		},
		reviewers: {
			core: (raw.reviewers as Record<string, string[]>)?.core ?? ["clotho", "lachesis", "atropos"],
			pool: (raw.reviewers as Record<string, string[]>)?.pool ?? ["urania", "daedalus", "iris", "minerva", "mnemosyne", "vulcan"],
			maxOptional: (raw.reviewers as Record<string, number>)?.max_optional ?? 4,
			tagMapping: (raw.reviewers as Record<string, Record<string, string>>)?.tag_mapping ?? {},
		},
	};
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
	if (!swarm.agents || typeof swarm.agents !== "object" || Object.keys(swarm.agents).length === 0) {
		throw new Error("swarm.agents must contain at least one agent");
	}

	const mode = swarm.mode ?? "sequential";
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
		});
	}

	// Resolve loop config first so targetCount can inherit maxIterations
	const loopConfig =
		mode === "loop" ? resolveLoopConfig(raw.swarm as unknown as Record<string, unknown>) : undefined;

	return {
		name: swarm.name,
		workspace: swarm.workspace,
		mode: mode as SwarmMode,
		targetCount: loopConfig?.maxIterations ?? swarm.target_count ?? 1,
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
		if (agent.model !== undefined && agent.model.length === 0) {
			errors.push(`Agent '${name}' model must not be empty when provided`);
		}
	}

	if (def.targetCount < 1) {
		errors.push("target_count must be at least 1");
	}
	if (def.mode !== "pipeline" && def.mode !== "loop" && def.targetCount !== 1) {
		errors.push("target_count is only supported in pipeline and loop mode");
	}

	return errors;
}
