/**
 * Theatre Graph schema — GraphDefinition types, YAML parser, and compile-time validator.
 *
 * ADR-7: Graph nodes represent workflow stages (script/stage/curtain/custom)
 * connected by directed edges. The graph is validated for cycles, missing
 * dependencies, and structural correctness before execution.
 */

import type { AgentSpec } from "../../graph/agent-spec";
import { detectCycles } from "../core/dag";
import { normalizeGateSpec, normalizeRetrySpec } from "./schema-gate";

// Re-export all graph types from the canonical location.
export * from "../../graph/types";

// Local imports needed for runtime function signatures and NodeBehavior.
import type {
	GateResult,
	GateSpec,
	GraphDefaults,
	GraphDefinition,
	GraphEdge,
	GraphHook,
	GraphNode,
	GraphValidationError,
	NodeContext,
	NodeOutput,
	NodeResult,
	NodeType,
	RawGateSpec,
	RawRetrySpec,
	Strategy,
} from "../../graph/types";
import { VALID_GATE_MODES, VALID_GATE_TYPES } from "../../graph/types";

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

interface RawGraphNode {
	label: string;
	description: string;
	type?: string;
	role: string;
	profile_id?: string;
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
const VALID_GRAPH_NAME = /^[a-zA-Z0-9._-]+$/;

// ============================================================================
// Parsing helpers
// ============================================================================

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
		throw new Error(`Invalid strategy '${strategy}'. Must be one of: ${Object.keys(VALID_STRATEGIES).join(", ")}`);
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
			profile_id: rawNode.profile_id,
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
