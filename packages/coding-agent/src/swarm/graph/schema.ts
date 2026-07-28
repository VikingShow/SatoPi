/**
 * Theatre Graph schema — GraphDefinition types, YAML parser, and compile-time validator.
 *
 * ADR-7: Graph nodes represent workflow stages (script/stage/curtain/custom)
 * connected by directed edges. The graph is validated for cycles, missing
 * dependencies, and structural correctness before execution.
 */

import { detectCycles } from "../core/dag";

// ============================================================================
// Discriminated unions
// ============================================================================

/** Node type determines which behavior controller drives execution. */
export type NodeType = "script" | "stage" | "curtain" | "custom";

/** Execution strategy for wave scheduling. */
export type Strategy = "waves" | "dynamic";

/** Gate types map to built-in verification steps. */
export type GateType = "compile-check" | "test" | "lsp" | "human-review" | "script";

/** When the gate check should run. */
export type GateMode = "always" | "on-failure" | "never";

/** Retry backoff strategy. */
export type RetryStrategy = "exponential" | "constant" | "linear";

/** What happens when all retry attempts are exhausted. */
export type RetryOnFailure = "block" | "skip" | "ask-human";

// ============================================================================
// Core types
// ============================================================================

/**
 * Named output artifact produced by a node.
 * Referenced by downstream nodes via edge artifacts.
 */
export interface NodeOutput {
	/** Unique output identifier within the node. */
	id: string;
	/** Human-readable description of the output. */
	description?: string;
}

/**
 * Gate specification — a verification gate that runs before/after a node.
 */
export interface GateSpec {
	/** Built-in gate type or custom script gate. */
	type: GateType;
	/** Shell command for compile-check/test/lsp/script gates. */
	command?: string;
	/** Prompt text for human-review gates. */
	prompt?: string;
	/** Choices presented to the human reviewer. */
	options?: string[];
	/** When the gate should trigger (default: "always"). */
	mode?: GateMode;
}

/** Retry configuration for node execution failures. */
export interface RetrySpec {
	/** Maximum number of retry attempts (>= 1). */
	maxAttempts: number;
	/** Backoff strategy for inter-attempt delays. */
	strategy: RetryStrategy;
	/** Base delay in milliseconds before the first retry. */
	baseDelayMs: number;
	/** Behavior when all attempts are exhausted. */
	onFailure: RetryOnFailure;
}

/**
 * A single node in the theatre graph.
 *
 * Nodes declare their role, tool set, and dependency edges.
 * Optional gate/retry/timeout control execution behavior.
 */
export interface GraphNode {
	/** Human-readable label for display in dashboards and logs. */
	label: string;
	/** Description of what this node does (injected as task context). */
	description: string;
	/** Node type — determines the behavior controller. Default "custom". */
	type?: NodeType;
	/** Agent role profile to use for this node's agent. */
	role: string;
	/** Tools available to the agent executing this node. */
	tools: string[];
	/** Node names this node depends on (must complete before this node starts). */
	depends_on: string[];
	/** Output artifacts this node produces (referenced by edge artifacts). */
	outputs?: NodeOutput[];
	/** Optional verification gate. */
	gate?: GateSpec;
	/** Timeout as a duration string (e.g. "5m", "1h"). */
	timeout?: string;
	/** Retry policy for execution failures. */
	retry?: RetrySpec;
	/** Heavy nodes reserve a dedicated worker (no multiplexing). */
	heavy?: boolean;
	/** If true, downstream nodes still execute after this node fails. */
	continue_on_failure?: boolean;
	/** Context source pipeline IDs to inject (offload, mnemopi, stigmergy, etc.). */
	context_sources?: string[];
	/** Maximum context tokens for the agent executing this node. */
	max_context_tokens?: number;
}

/**
 * A directed edge between two graph nodes.
 *
 * Edges carry optional artifact references — if specified, only the named
 * outputs from the source node are passed to the target.
 */
export interface GraphEdge {
	/** Source node name. */
	from: string;
	/** Target node name. */
	to: string;
	/** Artifact IDs to pass from source to target. All if omitted. */
	artifacts?: string[];
	/** Edge label for debugging and visualization. */
	label?: string;
}

/**
 * Lifecycle hook triggered at graph-level events.
 */
export interface GraphHook {
	/** Event name (e.g. "graph:beforeAll", "graph:afterAll", "node:before", "node:after"). */
	event: string;
	/** Shell command to run. */
	command?: string;
	/** Script file to execute. */
	script?: string;
}

/**
 * Default values applied to nodes that don't specify their own.
 */
export interface GraphDefaults {
	/** Default node type. */
	type?: NodeType;
	/** Default timeout. */
	timeout?: string;
	/** Default retry policy. */
	retry?: RetrySpec;
	/** Default heavy flag. */
	heavy?: boolean;
	/** Default continue_on_failure. */
	continue_on_failure?: boolean;
	/** Default tools available to all nodes. */
	tools?: string[];
	/** Default context sources. */
	context_sources?: string[];
}

/**
 * A validation error with a structured path for pinpoint UI.
 */
export interface GraphValidationError {
	/** Dot-separated path to the invalid field (e.g. "nodes.build.gate.type"). */
	path: string;
	/** Human-readable error message. */
	message: string;
}

/**
 * Top-level theatre graph definition.
 *
 * Parsed from YAML, this defines the complete workflow graph:
 * nodes + edges + hooks + defaults. version is the parser contract;
 * revision is the user-facing counter for change detection.
 */
export interface GraphDefinition {
	/** Graph name for logging and display. */
	name: string;
	/** Human-readable description of the graph's purpose. */
	description: string;
	/** Parser contract version (incremented when the schema shape changes). */
	version: number;
	/** User-facing revision counter (incremented when the user edits the graph). */
	revision: number;
	/** Execution strategy: "waves" (topological sort) or "dynamic" (runtime scheduler). */
	strategy?: Strategy;
	/** Maximum concurrent node executions. */
	max_concurrency?: number;
	/** All graph nodes, keyed by unique name. */
	nodes: Record<string, GraphNode>;
	/** Directed edges between nodes. */
	edges?: GraphEdge[];
	/** Graph-level lifecycle hooks. */
	hooks?: GraphHook[];
	/** Default values applied to nodes missing their own. */
	defaults?: GraphDefaults;
	/** Whether this is a built-in graph (e.g. theatre.graph.yaml). */
	builtin?: boolean;
}

// ============================================================================
// Runtime types — used by behaviors and executors at execution time
// ============================================================================

/**
 * Runtime output produced by an executed node.
 * Distinct from {@link NodeOutput} which is a compile-time artifact specification.
 */
export interface NodeExecutionOutput {
	/** The node that produced this output. */
	nodeId: string;
	/** File paths produced as artifacts. */
	artifacts: string[];
	/** Human-readable summary of what the node did. */
	summary: string;
	/** Raw execution result for downstream consumption. */
	result?: unknown;
}

/**
 * Minimal node definition consumed by NodeBehavior at runtime.
 * Subset of {@link GraphNode} covering everything a behavior needs.
 */
export interface NodeDefinition {
	/** Unique node identifier within the graph. */
	id: string;
	/** Human-readable label for UI rendering. */
	label: string;
	/** Natural-language description of what this node does. */
	description: string;
	/** Node type — drives which behavior is selected. */
	type?: NodeType;
	/** Role name resolved via RoleProvider. */
	role: string;
	/** Tools available to the agent spawned by this node. */
	tools: string[];
	/** Node IDs this node depends on (upstream). */
	dependsOn: string[];
	/** Gate to run after execution. */
	gate?: GateSpec;
	/** Timeout string (e.g. "30m", "2h"). */
	timeout?: string;
	/** Explicit AgentProfile binding. */
	profileId?: string;
}

/**
 * Result of a single node execution by a behavior.
 */
export interface NodeResult {
	/** Node that produced this result. */
	nodeId: string;
	/** Whether the agent completed without errors. */
	success: boolean;
	/** Agent output text. */
	output?: string;
	/** File paths produced by this node. */
	artifacts?: string[];
	/** Error message if execution failed. */
	error?: string;
	/** Per-agent results for downstream consumption. */
	agentResults?: Array<{ agentId: string; output: string; error?: string }>;
}

/**
 * Outcome of gate validation after node execution.
 */
export interface GateResult {
	/** Whether all gates passed. */
	passed: boolean;
	/** Descriptions of failed gates. */
	failures: string[];
	/** Whether the human must review before proceeding. */
	humanReviewRequired: boolean;
	/** Recommended retry strategy based on failure type. */
	retryStrategy?: "immediate" | "fixup" | "human";
}

import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { AgentRuntime } from "../agent-runtime";
import type { RoleAssetManager } from "../../agent/role-asset";
import type { ProfileRegistry } from "../../agent/agent-profile";
import type { StateTracker } from "../core/state";
import type { ActivityLogger } from "../infra/activity-logger";
import type { AgentSpec } from "../agent-runtime/agent-spec";

/**
 * Context assembled by GraphExecutor and injected into every NodeBehavior method.
 */
export interface NodeContext {
	/** The node definition being executed. */
	node: NodeDefinition;
	/** Absolute path to the project workspace. */
	workspace: string;
	/** Model registry for resolving model references. */
	modelRegistry: ModelRegistry;
	/** Application settings (provider keys, concurrency, etc.). */
	settings: Settings;
	/** Outputs from nodes listed in node.dependsOn (keyed by node ID). */
	upstreamOutputs: Record<string, NodeExecutionOutput>;
	/** Concatenated lessons / hints from prior runs (ExperienceStore). */
	experience: string;
	/** AbortSignal for cooperative cancellation. */
	signal: AbortSignal;
	/** Agent runtime for spawning sub-agents. */
	runtime: AgentRuntime;
	/** Role asset manager for library-based role resolution. */
	roleAssetManager?: RoleAssetManager;
	/** Agent profile registry for cross-run identity. */
	profileRegistry?: ProfileRegistry;
	/** State tracker for phase transitions and agent status. */
	stateTracker?: StateTracker;
	/** Activity logger for event auditing. */
	activityLogger?: ActivityLogger;
}

/**
 * Pluggable behavior contract for a single Theatre Graph node.
 *
 * ADR-3: Each node type selects a behavior that follows the lifecycle:
 * prepare → execute → validate → cleanup.
 */
export interface NodeBehavior {
	/** Human-readable name for diagnostics and logging. */
	readonly name: string;

	/**
	 * Prepare: assemble agent specs from the node definition.
	 * Called once before execute().
	 */
	prepare(ctx: NodeContext): Promise<AgentSpec[]>;

	/**
	 * Execute: spawn the prepared agents and collect results.
	 */
	execute(ctx: NodeContext, prepared: AgentSpec[]): Promise<NodeResult>;

	/**
	 * Validate: run gate checks against the execution result.
	 * Called after execute() regardless of success/failure.
	 */
	validate(result: NodeResult, gate?: GateSpec): Promise<GateResult>;

	/**
	 * Cleanup: abort any still-running agents and release resources.
	 * Called after validate(), even if execute() threw. Must be idempotent.
	 */
	cleanup(ctx: NodeContext): Promise<void>;
}

// ============================================================================
// Raw YAML shapes (snake_case input)
// ============================================================================

interface RawNodeOutput {
	id: string;
	description?: string;
}

interface RawGateSpec {
	type: string;
	command?: string;
	prompt?: string;
	options?: string[];
	mode?: string;
}

interface RawRetrySpec {
	max_attempts: number;
	strategy: string;
	base_delay_ms: number;
	on_failure: string;
}

interface RawGraphNode {
	label: string;
	description: string;
	type?: string;
	role: string;
	tools: string[];
	depends_on?: string[];
	outputs?: RawNodeOutput[];
	gate?: RawGateSpec;
	timeout?: string;
	retry?: RawRetrySpec;
	heavy?: boolean;
	continue_on_failure?: boolean;
	context_sources?: string[];
	max_context_tokens?: number;
}

interface RawGraphEdge {
	from: string;
	to: string;
	artifacts?: string[];
	label?: string;
}

interface RawGraphHook {
	event: string;
	command?: string;
	script?: string;
}

interface RawGraphDefaults {
	type?: string;
	timeout?: string;
	retry?: RawRetrySpec;
	heavy?: boolean;
	continue_on_failure?: boolean;
	tools?: string[];
	context_sources?: string[];
}

interface RawGraphDefinition {
	name: string;
	description: string;
	version: number;
	revision: number;
	strategy?: string;
	max_concurrency?: number;
	nodes: Record<string, RawGraphNode>;
	edges?: RawGraphEdge[];
	hooks?: RawGraphHook[];
	defaults?: RawGraphDefaults;
}

// ============================================================================
// Constants
// ============================================================================

const VALID_NODE_TYPES: Record<string, true> = { script: true, stage: true, curtain: true, custom: true };
const VALID_STRATEGIES: Record<string, true> = { waves: true, dynamic: true };
const VALID_GATE_TYPES: Record<string, true> = { "compile-check": true, test: true, lsp: true, "human-review": true, script: true };
const VALID_GATE_MODES: Record<string, true> = { always: true, "on-failure": true, never: true };
const VALID_RETRY_STRATEGIES: Record<string, true> = { exponential: true, constant: true, linear: true };
const VALID_ON_FAILURE: Record<string, true> = { block: true, skip: true, "ask-human": true };
const VALID_GRAPH_NAME = /^[a-zA-Z0-9._-]+$/;

// ============================================================================
// Parsing helpers
// ============================================================================

function normalizeRetrySpec(raw: RawRetrySpec): RetrySpec {
	if (raw.max_attempts < 1) {
		throw new Error("retry.max_attempts must be >= 1");
	}
	if (!VALID_RETRY_STRATEGIES[raw.strategy]) {
		throw new Error(
			`Invalid retry strategy '${raw.strategy}'. Must be one of: ${Object.keys(VALID_RETRY_STRATEGIES).join(", ")}`,
		);
	}
	if (raw.base_delay_ms < 0) {
		throw new Error("retry.base_delay_ms must be >= 0");
	}
	if (!VALID_ON_FAILURE[raw.on_failure]) {
		throw new Error(
			`Invalid on_failure '${raw.on_failure}'. Must be one of: ${Object.keys(VALID_ON_FAILURE).join(", ")}`,
		);
	}
	return {
		maxAttempts: raw.max_attempts,
		strategy: raw.strategy as RetryStrategy,
		baseDelayMs: raw.base_delay_ms,
		onFailure: raw.on_failure as RetryOnFailure,
	};
}

function normalizeGateSpec(raw: RawGateSpec): GateSpec {
	if (!VALID_GATE_TYPES[raw.type]) {
		throw new Error(
			`Invalid gate type '${raw.type}'. Must be one of: ${Object.keys(VALID_GATE_TYPES).join(", ")}`,
		);
	}
	if (raw.mode !== undefined && !VALID_GATE_MODES[raw.mode]) {
		throw new Error(
			`Invalid gate mode '${raw.mode}'. Must be one of: ${Object.keys(VALID_GATE_MODES).join(", ")}`,
		);
	}
	return {
		type: raw.type as GateType,
		command: raw.command,
		prompt: raw.prompt,
		options: raw.options,
		mode: raw.mode as GateMode | undefined,
	};
}

function normalizeNodeOutput(raw: RawNodeOutput): NodeOutput {
	if (!raw.id || typeof raw.id !== "string") {
		throw new Error("node output requires an 'id' field");
	}
	return { id: raw.id, description: raw.description };
}

// ============================================================================
// YAML Parsing
// ============================================================================

/**
 * Parse a YAML string into a normalized GraphDefinition.
 *
 * Handles snake_case → camelCase conversion, applies defaults,
 * and validates field-level constraints. Does NOT check graph-level
 * invariants (cycles, missing deps) — use `validateGraphDefinition()` for that.
 */
export function parseGraphYaml(content: string): GraphDefinition {
	const raw = Bun.YAML.parse(content) as { graph?: RawGraphDefinition } | null;
	if (!raw?.graph) {
		throw new Error("YAML must have a top-level 'graph' key");
	}
	const g = raw.graph;

	// Top-level checks
	if (!g.name || typeof g.name !== "string") {
		throw new Error("graph.name is required and must be a string");
	}
	if (!VALID_GRAPH_NAME.test(g.name)) {
		throw new Error("graph.name may only contain letters, numbers, dot, underscore, and dash");
	}
	if (!g.description || typeof g.description !== "string") {
		throw new Error("graph.description is required and must be a string");
	}
	if (typeof g.version !== "number" || !Number.isInteger(g.version) || g.version < 1) {
		throw new Error("graph.version is required and must be a positive integer");
	}
	if (typeof g.revision !== "number" || !Number.isInteger(g.revision) || g.revision < 0) {
		throw new Error("graph.revision is required and must be a non-negative integer");
	}

	const strategy = g.strategy ?? "waves";
	if (!VALID_STRATEGIES[strategy]) {
		throw new Error(
			`Invalid strategy '${strategy}'. Must be one of: ${Object.keys(VALID_STRATEGIES).join(", ")}`,
		);
	}

	if (g.max_concurrency !== undefined && (typeof g.max_concurrency !== "number" || g.max_concurrency < 0)) {
		throw new Error("graph.max_concurrency must be a non-negative integer");
	}

	if (!g.nodes || typeof g.nodes !== "object" || Object.keys(g.nodes).length === 0) {
		throw new Error("graph.nodes must be a non-empty object");
	}

	// Normalize nodes
	const nodes: Record<string, GraphNode> = {};
	for (const [name, rawNode] of Object.entries(g.nodes)) {
		if (!rawNode.label || typeof rawNode.label !== "string") {
			throw new Error(`Node '${name}': 'label' is required`);
		}
		if (!rawNode.description || typeof rawNode.description !== "string") {
			throw new Error(`Node '${name}': 'description' is required`);
		}
		if (rawNode.type !== undefined && !VALID_NODE_TYPES[rawNode.type]) {
			throw new Error(
				`Node '${name}': invalid type '${rawNode.type}'. Must be one of: ${Object.keys(VALID_NODE_TYPES).join(", ")}`,
			);
		}
		if (!rawNode.role || typeof rawNode.role !== "string") {
			throw new Error(`Node '${name}': 'role' is required`);
		}
		if (!Array.isArray(rawNode.tools)) {
			throw new Error(`Node '${name}': 'tools' must be an array`);
		}

		nodes[name] = {
			label: rawNode.label,
			description: rawNode.description,
			type: rawNode.type as NodeType | undefined,
			role: rawNode.role,
			tools: rawNode.tools.map(t => String(t).trim()).filter(Boolean),
			depends_on: Array.isArray(rawNode.depends_on) ? rawNode.depends_on : [],
			outputs: rawNode.outputs?.map(normalizeNodeOutput),
			gate: rawNode.gate ? normalizeGateSpec(rawNode.gate) : undefined,
			timeout: rawNode.timeout,
			retry: rawNode.retry ? normalizeRetrySpec(rawNode.retry) : undefined,
			heavy: rawNode.heavy,
			continue_on_failure: rawNode.continue_on_failure,
			context_sources: rawNode.context_sources,
			max_context_tokens: rawNode.max_context_tokens,
		};
	}

	// Normalize edges
	const edges: GraphEdge[] | undefined = g.edges?.map((e, i) => {
		if (!e.from || typeof e.from !== "string") {
			throw new Error(`Edge[${i}]: 'from' is required`);
		}
		if (!e.to || typeof e.to !== "string") {
			throw new Error(`Edge[${i}]: 'to' is required`);
		}
		return {
			from: e.from,
			to: e.to,
			artifacts: e.artifacts,
			label: e.label,
		};
	});

	// Normalize hooks
	const hooks: GraphHook[] | undefined = g.hooks?.map((h, i) => {
		if (!h.event || typeof h.event !== "string") {
			throw new Error(`Hook[${i}]: 'event' is required`);
		}
		if (!h.command && !h.script) {
			throw new Error(`Hook[${i}]: at least one of 'command' or 'script' is required`);
		}
		return { event: h.event, command: h.command, script: h.script };
	});

	// Normalize defaults
	let defaults: GraphDefaults | undefined;
	if (g.defaults) {
		const d = g.defaults;
		if (d.type !== undefined && !VALID_NODE_TYPES[d.type]) {
			throw new Error(`defaults: invalid type '${d.type}'`);
		}
		if (d.retry) {
			defaults = {
				type: d.type as NodeType | undefined,
				timeout: d.timeout,
				retry: normalizeRetrySpec(d.retry),
				heavy: d.heavy,
				continue_on_failure: d.continue_on_failure,
				tools: d.tools,
				context_sources: d.context_sources,
			};
		} else {
			defaults = {
				type: d.type as NodeType | undefined,
				timeout: d.timeout,
				heavy: d.heavy,
				continue_on_failure: d.continue_on_failure,
				tools: d.tools,
				context_sources: d.context_sources,
			};
		}
	}

	return {
		name: g.name,
		description: g.description,
		version: g.version,
		revision: g.revision,
		strategy: strategy as Strategy,
		max_concurrency: g.max_concurrency,
		nodes,
		edges,
		hooks,
		defaults,
	};
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Build a dependency map from graph nodes + edges: node name → set of deps.
 * Dependencies come from explicit `depends_on` and implicit edge `from` → `to`.
 *
 * Returns a Map compatible with detectCycles() and buildExecutionWaves()
 * from ../core/dag.
 */
export function buildGraphDependencyMap(def: GraphDefinition): Map<string, Set<string>> {
	const deps = new Map<string, Set<string>>();

	for (const name of Object.keys(def.nodes)) {
		deps.set(name, new Set());
	}

	// Explicit depends_on
	for (const [name, node] of Object.entries(def.nodes)) {
		for (const dep of node.depends_on) {
			deps.get(name)!.add(dep);
		}
	}

	// Implicit from edges
	if (def.edges) {
		for (const edge of def.edges) {
			// Edge from → to means `to` depends on `from`
			if (deps.has(edge.to)) {
				deps.get(edge.to)!.add(edge.from);
			}
		}
	}

	return deps;
}

/**
 * Validate a GraphDefinition for structural correctness.
 *
 * Checks:
 * - Cycle detection via topological sort
 * - Missing dependency references
 * - Self-dependency
 * - Invalid node types
 * - Missing required fields
 * - Edge references to non-existent nodes
 */
export function validateGraphDefinition(def: GraphDefinition): GraphValidationError[] {
	const errors: GraphValidationError[] = [];
	const nodeNames = new Set(Object.keys(def.nodes));

	// Per-node validation
	for (const [name, node] of Object.entries(def.nodes)) {
		// Required fields
		if (!node.label || node.label.trim().length === 0) {
			errors.push({ path: `nodes.${name}.label`, message: "label is required and must not be empty" });
		}
		if (!node.description || node.description.trim().length === 0) {
			errors.push({ path: `nodes.${name}.description`, message: "description is required and must not be empty" });
		}
		if (!node.role || node.role.trim().length === 0) {
			errors.push({ path: `nodes.${name}.role`, message: "role is required and must not be empty" });
		}

		// Invalid node type
		if (node.type !== undefined && !VALID_NODE_TYPES[node.type]) {
			errors.push({
				path: `nodes.${name}.type`,
				message: `Invalid node type '${node.type}'. Must be one of: ${Object.keys(VALID_NODE_TYPES).join(", ")}`,
			});
		}

		// Missing dependency references
		for (const dep of node.depends_on) {
			if (!nodeNames.has(dep)) {
				errors.push({
					path: `nodes.${name}.depends_on`,
					message: `Node '${name}' depends on unknown node '${dep}'`,
				});
			}
		}

		// Self-dependency
		if (node.depends_on.includes(name)) {
			errors.push({
				path: `nodes.${name}.depends_on`,
				message: `Node '${name}' cannot depend on itself`,
			});
		}

		// Retry validation
		if (node.retry) {
			if (node.retry.maxAttempts < 1) {
				errors.push({
					path: `nodes.${name}.retry.maxAttempts`,
					message: "maxAttempts must be >= 1",
				});
			}
			if (node.retry.baseDelayMs < 0) {
				errors.push({
					path: `nodes.${name}.retry.baseDelayMs`,
					message: "baseDelayMs must be >= 0",
				});
			}
		}

		// Gate validation
		if (node.gate) {
			if (!VALID_GATE_TYPES[node.gate.type]) {
				errors.push({
					path: `nodes.${name}.gate.type`,
					message: `Invalid gate type '${node.gate.type}'`,
				});
			}
			if (node.gate.mode !== undefined && !VALID_GATE_MODES[node.gate.mode]) {
				errors.push({
					path: `nodes.${name}.gate.mode`,
					message: `Invalid gate mode '${node.gate.mode}'`,
				});
			}
		}
	}

	// Edge validation
	if (def.edges) {
		for (let i = 0; i < def.edges.length; i++) {
			const edge = def.edges[i];
			if (!nodeNames.has(edge.from)) {
				errors.push({
					path: `edges[${i}].from`,
					message: `Edge references unknown source node '${edge.from}'`,
				});
			}
			if (!nodeNames.has(edge.to)) {
				errors.push({
					path: `edges[${i}].to`,
					message: `Edge references unknown target node '${edge.to}'`,
				});
			}
			if (edge.from === edge.to) {
				errors.push({
					path: `edges[${i}]`,
					message: `Edge cannot connect node '${edge.from}' to itself`,
				});
			}
		}
	}

	// Top-level validation
	if (def.version < 1) {
		errors.push({ path: "version", message: "version must be a positive integer" });
	}
	if (def.revision < 0) {
		errors.push({ path: "revision", message: "revision must be a non-negative integer" });
	}
	if (def.strategy !== undefined && !VALID_STRATEGIES[def.strategy]) {
		errors.push({
			path: "strategy",
			message: `Invalid strategy '${def.strategy}'. Must be one of: ${Object.keys(VALID_STRATEGIES).join(", ")}`,
		});
	}
	if (def.max_concurrency !== undefined && def.max_concurrency < 0) {
		errors.push({
			path: "max_concurrency",
			message: "max_concurrency must be a non-negative integer",
		});
	}

	// Graph-level cycle detection (uses the shared DAG utilities)
	const deps = buildGraphDependencyMap(def);
	const cycleNodes = detectCycles(deps);
	if (cycleNodes && cycleNodes.length > 0) {
		errors.push({
			path: "nodes",
			message: `Dependency cycle detected involving: ${cycleNodes.join(", ")}`,
		});
	}

	return errors;
}

// ============================================================================
// File loading
// ============================================================================

/**
 * Load a graph definition from a YAML file path.
 *
 * Reads the file, parses the YAML, and runs validation. Throws if
 * the file cannot be read or if validation errors are found.
 *
 * Returns the parsed GraphDefinition on success.
 */
export async function loadGraphDefinition(yamlPath: string): Promise<GraphDefinition> {
	const file = Bun.file(yamlPath);
	if (!(await file.exists())) {
		throw new Error(`Graph definition file not found: ${yamlPath}`);
	}
	const content = await file.text();
	const def = parseGraphYaml(content);
	const errors = validateGraphDefinition(def);
	if (errors.length > 0) {
		const messages = errors.map(e => `  ${e.path}: ${e.message}`).join("\n");
		throw new Error(`Graph validation failed for '${yamlPath}':\n${messages}`);
	}
	return def;
}
