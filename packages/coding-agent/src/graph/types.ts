/**
 * Graph types — canonical location for all Theatre Graph type definitions.
 *
 * Types extracted from swarm/graph/schema.ts, schema-gate.ts, checkpoint.ts,
 * and gate-controller.ts so that the graph/ module can be a standalone pure-DAG
 * executor without pulling in Swarm-specific parsing, validation, or persistence.
 */

import type { ProfileRegistry } from "../agent/agent-profile";
import type { RoleAssetManager } from "../agent/role-asset";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { AgentRegistry } from "../registry/agent-registry";
import type { AgentRuntime } from "../swarm/agent-runtime";
import type { StateTracker } from "../swarm/core/state";
import type { ActivityLogger } from "../swarm/infra/activity-logger";

// ============================================================================
// Gate discriminated unions
// ============================================================================

/** Gate types map to built-in verification steps. */
export type GateType = "compile-check" | "test" | "lsp" | "human-review" | "script";

/** When the gate check should run. */
export type GateMode = "always" | "on-failure" | "never";

/** Retry backoff strategy. */
export type RetryStrategy = "exponential" | "constant" | "linear";

/** What happens when all retry attempts are exhausted. */
export type RetryOnFailure = "block" | "skip" | "ask-human";

// ============================================================================
// Gate & retry interfaces
// ============================================================================

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

// ============================================================================
// Raw YAML shapes (snake_case input)
// ============================================================================

export interface RawGateSpec {
	type: string;
	command?: string;
	prompt?: string;
	options?: string[];
	mode?: string;
}

export interface RawRetrySpec {
	max_attempts: number;
	strategy: string;
	base_delay_ms: number;
	on_failure: string;
}

// ============================================================================
// Gate validation constants
// ============================================================================

export const VALID_GATE_TYPES: Record<string, true> = {
	"compile-check": true,
	test: true,
	lsp: true,
	"human-review": true,
	script: true,
};

export const VALID_GATE_MODES: Record<string, true> = { always: true, "on-failure": true, never: true };

export const VALID_RETRY_STRATEGIES: Record<string, true> = { exponential: true, constant: true, linear: true };

export const VALID_ON_FAILURE: Record<string, true> = { block: true, skip: true, "ask-human": true };

// ============================================================================
// Gate action (from gate-controller)
// ============================================================================

/**
 * Decision returned by the gate controller after evaluating a gate result.
 * Drives retry/block/continue decisions in the orchestrator.
 */
export type GateAction = { type: "retry"; delayMs: number } | { type: "block"; reason: string } | { type: "continue" };

// ============================================================================
// Node discriminated unions
// ============================================================================

/** Node type determines which behavior controller drives execution. */
export type NodeType = "script" | "stage" | "curtain" | "custom";

/** Execution strategy for wave scheduling. */
export type Strategy = "waves" | "dynamic";

// ============================================================================
// Graph core types
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
 * A single node in the theatre graph.
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
	/** Persistent agent profile ID — when set, routes to an existing persistent agent instead of spawning ephemeral. */
	profile_id?: string;
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
	/** Agent registry for persistent agent routing and lifecycle management. */
	agentRegistry: AgentRegistry;
	/** Role asset manager for library-based role resolution. */
	roleAssetManager?: RoleAssetManager;
	/** Agent profile registry for cross-run identity. */
	profileRegistry?: ProfileRegistry;
	/** State tracker for phase transitions and agent status. */
	stateTracker?: StateTracker;
	/** Activity logger for event auditing. */
	activityLogger?: ActivityLogger;
}

// ============================================================================
// Checkpoint types (type definitions only — I/O functions stay in checkpoint.ts)
// ============================================================================

export type NodeStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type GraphRunStatus = "running" | "completed" | "failed" | "aborted";

export interface NodeRunState {
	nodeId: string;
	status: NodeStatus;
	startedAt?: number;
	completedAt?: number;
	error?: string;
	/** References to output artifacts produced by this node (file paths, artifact URIs). */
	outputRefs?: string[];
}

export interface GraphRunState {
	/** Logical name of the graph definition (e.g. "theatre-main"). */
	graphName: string;
	/** Unique run identifier — survives restarts. */
	runId: string;
	/** Epoch ms when this run was initiated. */
	startedAt: number;
	/** Node state keyed by node id. */
	nodes: Record<string, NodeRunState>;
	/** Which wave the executor is currently processing (0-based). */
	currentWave: number;
	/** Overall run status. */
	status: GraphRunStatus;
}
