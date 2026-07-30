/**
 * Loop YAML → Graph Definition converter.
 *
 * Converts legacy swarm.yaml files to the Theatre Graph format,
 * mapping swarm agents to graph nodes and loop config to node metadata.
 */

import {
	type GateSpec,
	type GraphDefinition,
	type GraphEdge,
	type GraphHook,
	type GraphNode,
	type NodeOutput,
	type NodeType,
	validateGraphDefinition,
} from "../graph/schema";
import { type LoopSwarmConfig, parseSwarmYaml, type SwarmAgent, type SwarmDefinition } from "./core/schema";

// ============================================================================
// Constants
// ============================================================================

/** Node names reserved for the three-phase theatre structure. */
const RESERVED_NODES: ReadonlySet<string> = new Set(["script", "stage", "curtain"]);

/** Default stage tools — mirrors the built-in theatre graph. */
const DEFAULT_STAGE_TOOLS: readonly string[] = [
	"read",
	"write",
	"edit",
	"grep",
	"bash",
	"task",
	"irc",
	"todo",
	"agent_fork",
];

/** Default script tools. */
const SCRIPT_TOOLS: readonly string[] = ["read", "grep", "glob", "write", "edit", "bash", "web_search"];

/** Default curtain tools. */
const CURTAIN_TOOLS: readonly string[] = ["read", "write", "bash"];

// ============================================================================
// Public API
// ============================================================================

/**
 * Convert a loop YAML string into a validated GraphDefinition.
 *
 * The conversion follows these rules:
 * - The top-level `swarm` section is parsed via {@link parseSwarmYaml}.
 * - Three mandatory nodes are always created: `script`, `stage`, `curtain`.
 * - Each swarm agent becomes an additional custom node dependant on `stage`.
 * - Pipeline semantics: all non-curtain nodes carry `continue_on_failure: false`.
 * - `extra_context` from agent definitions maps to `context_sources`.
 *
 * @param loopYaml - Raw YAML content (the `swarm:` document).
 * @param name     - Graph name (overrides the swarm name from the YAML).
 * @returns A complete, validated GraphDefinition ready for execution.
 */
export function convertLoopToGraph(loopYaml: string, name: string): GraphDefinition {
	const swarmDef = parseSwarmYaml(loopYaml);
	const loopConfig = swarmDef.loopConfig;

	const nodes: Record<string, GraphNode> = {};

	// ── Script node ──────────────────────────────────────────────────
	nodes.script = buildScriptNode(swarmDef, loopConfig);

	// ── Stage node ───────────────────────────────────────────────────
	nodes.stage = buildStageNode(swarmDef, loopConfig);

	// ── Curtain node ─────────────────────────────────────────────────
	nodes.curtain = buildCurtainNode(loopConfig);

	// ── Agent nodes (from swarm agent definitions) ───────────────────
	for (const [agentName, agent] of swarmDef.agents) {
		// Skip agents whose name would collide with the three mandatory nodes.
		if (RESERVED_NODES.has(agentName)) continue;
		nodes[agentName] = buildAgentNode(agent);
	}

	// ── Edges ────────────────────────────────────────────────────────
	const edges = buildEdges(swarmDef);

	// ── Hooks ────────────────────────────────────────────────────────
	const hooks = buildHooks(loopConfig);

	return {
		name,
		description: buildGraphDescription(swarmDef, loopConfig),
		version: 1,
		revision: 1,
		strategy: "waves",
		nodes,
		edges,
		...(hooks && { hooks }),
	};
}

/**
 * Read a loop YAML file from disk, convert it, and validate the result.
 *
 * @param loopPath - Filesystem path to the `.yaml` / `.yml` file.
 * @returns A validated GraphDefinition.
 * @throws If the file does not exist, cannot be parsed, or validation fails.
 */
export async function convertLoopFileToGraph(loopPath: string): Promise<GraphDefinition> {
	const file = Bun.file(loopPath);
	if (!(await file.exists())) {
		throw new Error(`Loop YAML file not found: ${loopPath}`);
	}
	const content = await file.text();

	// Derive graph name from the filename, stripping extensions.
	const basename =
		loopPath
			.split("/")
			.pop()
			?.replace(/\.(ya?ml)$/, "") ?? "loop-converted";

	const def = convertLoopToGraph(content, basename);
	const errors = validateGraphDefinition(def);
	if (errors.length > 0) {
		const messages = errors.map(e => `  ${e.path}: ${e.message}`).join("\n");
		throw new Error(`Converted graph validation failed for '${loopPath}':\n${messages}`);
	}
	return def;
}

// ============================================================================
// Node builders
// ============================================================================

function buildScriptNode(swarmDef: SwarmDefinition, loopConfig: LoopSwarmConfig | undefined): GraphNode {
	const planDebate = loopConfig?.planDebate;
	const outputs: NodeOutput[] = [{ id: "plan", description: "Structured execution plan (plan.md)" }];

	const gate: GateSpec | undefined = planDebate?.enabled
		? {
				type: "human-review",
				mode: "always",
				prompt: "Plan is ready. Review the phases and confirm to launch Stage.",
				options: ["Launch Stage", "Revise Plan", "Cancel"],
			}
		: undefined;

	const description = planDebate?.enabled
		? `Interactive planning phase for swarm "${swarmDef.name}". Plan debate enabled: ${planDebate.agentCount} agents, ${planDebate.maxRounds} max rounds, convergence ≥ ${planDebate.convergenceThreshold}.`
		: `Interactive planning phase for swarm "${swarmDef.name}". An agent researches the codebase and produces a structured plan.md.`;

	return {
		label: "Script · Planning",
		description,
		type: "script" as NodeType,
		role: "planner",
		tools: [...SCRIPT_TOOLS],
		depends_on: [],
		outputs,
		...(gate && { gate }),
		timeout: "0",
		continue_on_failure: false,
	};
}

function buildStageNode(swarmDef: SwarmDefinition, loopConfig: LoopSwarmConfig | undefined): GraphNode {
	const agentConfig = loopConfig?.agents;
	const descriptionParts: string[] = [`Parallel execution phase for swarm "${swarmDef.name}".`];

	if (agentConfig) {
		descriptionParts.push(
			`Agents: ${agentConfig.initial} initial (min ${agentConfig.min}, max ${agentConfig.max}), ` +
				`${agentConfig.maxRounds} max rounds per iteration, ` +
				`auto-scaling: ${agentConfig.auto ? "enabled" : "disabled"}.`,
		);
		descriptionParts.push(
			`Debate: ${loopConfig?.debate?.enabled ? "enabled" : "disabled"}. ` +
				`Deliberation: ${loopConfig?.enableDeliberation ? "enabled" : "disabled"}. ` +
				`Max iterations: ${loopConfig?.maxIterations ?? 5}. ` +
				`Convergence: ${loopConfig?.convergenceThreshold ?? 2} identical reviews.`,
		);
	}

	// Collect tools from agents — merge allowed tools across all agents.
	const stageTools = mergeAgentTools(swarmDef);

	// Derive timeout from iteration timeout.
	const timeout = loopConfig?.iterationTimeoutMs
		? `${Math.max(1, Math.round(loopConfig.iterationTimeoutMs / 60_000))}m`
		: "30m";

	// Verification gate from loop config.
	const gate: GateSpec | undefined = loopConfig?.verification
		? {
				type: "test",
				mode: "on-failure",
				command: loopConfig.verification.commands.join(" && "),
			}
		: undefined;

	// Context sources from loop config features.
	const contextSources = resolveContextSources(loopConfig);

	return {
		label: "Stage · Execution",
		description: descriptionParts.join(" "),
		type: "stage" as NodeType,
		role: "stage-controller",
		tools: stageTools,
		depends_on: ["script"],
		heavy: true,
		...(gate && { gate }),
		timeout,
		continue_on_failure: false,
		max_context_tokens: 8000,
		...(contextSources.length > 0 && { context_sources: contextSources }),
	};
}

function buildCurtainNode(_loopConfig: LoopSwarmConfig | undefined): GraphNode {
	return {
		label: "Curtain · Reflection",
		description:
			"Closing phase. Elects a reporter agent to summarize the delivery, " +
			"runs reflection agents to extract lessons, and persists experience " +
			"to the ExperienceStore. Optionally awaits human applaud.",
		type: "curtain" as NodeType,
		role: "reflector",
		tools: [...CURTAIN_TOOLS],
		depends_on: ["stage"],
		gate: {
			type: "human-review",
			mode: "always",
			prompt: "Delivery complete. Review the summary and applaud to finish.",
			options: ["Applaud", "Needs Revision"],
		},
		timeout: "5m",
		continue_on_failure: true, // Curtain always runs — mirrors built-in graph.
	};
}

function buildAgentNode(agent: SwarmAgent): GraphNode {
	const tools = agent.allowedTools ?? [];
	const contextSources: string[] = [];

	// Map extra_context → context_sources (spec: extra_context → node.context_overrides,
	// GraphNode uses context_sources as the context pipeline field).
	if (agent.extraContext) {
		contextSources.push(agent.extraContext);
	}

	return {
		label: `Agent · ${agent.name}`,
		description: agent.task || `Worker agent — role: ${agent.role}`,
		type: "custom" as NodeType,
		role: agent.role,
		tools,
		depends_on: ["stage"],
		continue_on_failure: false,
		...(contextSources.length > 0 && { context_sources: contextSources }),
		...(agent.model &&
			{
				/* model info noted in description */
			}),
	};
}

// ============================================================================
// Helpers
// ============================================================================

function buildEdges(swarmDef: SwarmDefinition): GraphEdge[] {
	const edges: GraphEdge[] = [
		{ from: "script", to: "stage", label: "plan → execute" },
		{ from: "stage", to: "curtain", label: "execute → reflect" },
	];

	// Edge from stage to each non-reserved agent node.
	for (const [agentName] of swarmDef.agents) {
		if (RESERVED_NODES.has(agentName)) continue;
		edges.push({ from: "stage", to: agentName, label: "spawn worker" });
	}

	return edges;
}

function buildHooks(loopConfig: LoopSwarmConfig | undefined): GraphHook[] | undefined {
	if (!loopConfig?.hooks || loopConfig.hooks.length === 0) return undefined;

	return loopConfig.hooks.map(h => ({
		event: h.event,
		...(h.command && { command: h.command }),
		...(h.script && { script: h.script }),
	}));
}

/** Merge allowed tools across all agents for the stage node's tool set. */
function mergeAgentTools(swarmDef: SwarmDefinition): string[] {
	const toolSet = new Set(DEFAULT_STAGE_TOOLS);

	for (const agent of swarmDef.agents.values()) {
		if (agent.allowedTools) {
			for (const t of agent.allowedTools) {
				toolSet.add(t);
			}
		}
	}

	return [...toolSet];
}

/** Derive context source identifiers from enabled loop-config features. */
function resolveContextSources(loopConfig: LoopSwarmConfig | undefined): string[] {
	if (!loopConfig) return [];

	const sources: string[] = [];
	if (loopConfig.mnemopi) sources.push("mnemopi");
	if (loopConfig.offload) sources.push("offload");
	if (loopConfig.stigmergy) sources.push("stigmergy");
	return sources;
}

function buildGraphDescription(swarmDef: SwarmDefinition, loopConfig: LoopSwarmConfig | undefined): string {
	const agentCount = swarmDef.agents.size;
	const iter = loopConfig?.maxIterations ?? 5;
	return (
		`Converted from loop swarm "${swarmDef.name}". ` +
		`${agentCount} agent${agentCount !== 1 ? "s" : ""}, ` +
		`max ${iter} iteration${iter !== 1 ? "s" : ""}.`
	);
}
