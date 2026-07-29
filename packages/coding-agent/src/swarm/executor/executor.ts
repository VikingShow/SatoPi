/**
 * Swarm agent execution — in-process via AgentRuntime.spawn().
 *
 * Each agent runs with its task instructions as the user prompt.
 *
 * ## Extensibility
 *
 * The `AgentExecutor` interface allows callers to inject custom execution
 * strategies (e.g. remote agents, HTTP-triggered agents) without modifying
 * the pipeline controller.
 */

import type { AgentLoopConfig } from "@satopi/pi-agent-core";
import type {
	AgentDefinition,
	AgentProgress,
	AgentSource,
	ModelRegistry,
	Settings,
	SingleResult,
} from "@satopi/pi-coding-agent";
import type { AgentRuntime } from "../agent-runtime";
import type { SwarmAgent } from "../core/schema";
import type { StateTracker } from "../core/state";
import type { ActivityLogger } from "../infra/activity-logger";

/** Default per-agent wall-clock cap (5 minutes). */
const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================================
// P1-2: Agent Executor Interface — decouples execution strategy from pipeline
// ============================================================================

/**
 * Injectable agent execution strategy.
 *
 * The default path uses AgentRuntime.spawn() in-process.
 * Callers can inject a custom executor through SwarmExecutorOptions.executor
 * to support remote agents, sandboxed environments, or testing mocks.
 */
export interface AgentExecutor {
	execute(agent: SwarmAgent, index: number, options: SwarmExecutorOptions): Promise<SingleResult>;
}

export interface SwarmExecutorOptions {
	workspace: string;
	swarmName: string;
	iteration: number;
	modelOverride?: string;
	signal?: AbortSignal;
	onProgress?: (agentName: string, progress: AgentProgress) => void;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
	stateTracker: StateTracker;
	/**
	 * Per-agent wall-clock timeout in milliseconds.
	 * When exceeded the agent is aborted and marked as CRASHED.
	 * Defaults to 5 minutes. Set to 0 to disable.
	 */
	timeoutMs?: number;
	/**
	 * Callback invoked when the agent starts.
	 * Receives an AbortController that the caller can use to
	 * terminate the agent externally (e.g. on pipeline abort).
	 */
	onStarted?: (controller: AbortController) => void;
	/**
	 * Custom executor override. When provided the pipeline delegates
	 * agent execution to this executor.
	 */
	executor?: AgentExecutor;
	/**
	 * v3 AgentRuntime for in-process agent spawning.
	 * Required for swarm agent execution.
	 */
	runtime?: AgentRuntime;
	/**
	 * Optional tool hooks passed through to the runtime.
	 * beforeToolCall can block write/edit/bash calls (e.g. deliberation phase).
	 * afterToolCall is used for lock release coordination.
	 */
	toolHooks?: {
		beforeToolCall?: AgentLoopConfig["beforeToolCall"];
		afterToolCall?: AgentLoopConfig["afterToolCall"];
	};
	/**
	 * Optional AgentDefinition overrides merged into the built agent def.
	 * Lets callers supply custom systemPrompt, tools, blockedTools, source, etc.
	 */
	agentOverrides?: Partial<AgentDefinition>;
	/** Optional activity logger for SSE streaming output. */
	activityLogger?: ActivityLogger;
	/** Optional: transform context hook. */
	transformContext?: (messages: unknown[], signal?: AbortSignal) => Promise<unknown>;
	/** Optional: after-tool-call hook. */
	afterToolCall?: (ctx: unknown, signal?: AbortSignal) => void;
}

/**
 * Execute a single swarm agent.
 *
 * The runtime parameter MUST be provided — the legacy subprocess fallback
 * has been removed (v3). Throws if runtime is not provided.
 */
// biome-ignore lint/correctness/noUnusedVariables: internal, used by tests
async function executeSwarmAgent(
	agent: SwarmAgent,
	index: number,
	options: SwarmExecutorOptions,
): Promise<SingleResult> {
	// Delegate to custom executor if provided.
	if (options.executor) {
		return options.executor.execute(agent, index, options);
	}

	const { runtime } = options;

	if (!runtime) {
		throw new Error("AgentRuntime is required for swarm agent execution");
	}

	return executeWithRuntime(agent, index, options, runtime);
}

/**
 * Execute a swarm agent via AgentRuntime.spawn() (v3 in-process path).
 */
async function executeWithRuntime(
	agent: SwarmAgent,
	index: number,
	options: SwarmExecutorOptions,
	runtime: AgentRuntime,
): Promise<SingleResult> {
	const {
		swarmName,
		iteration,
		stateTracker,
		timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
		onStarted,
		activityLogger,
	} = options;

	const agentId = `swarm-${swarmName}-${agent.name}-${iteration}`;

	// Notify the caller for abort tracking.
	const agentController = new AbortController();
	onStarted?.(agentController);

	await stateTracker.updateAgent(agent.name, {
		status: "running",
		iteration,
		startedAt: Date.now(),
	});
	await stateTracker.appendLog(agent.name, `Starting iteration ${iteration} (v3 runtime)`);

	const streamMsgId = `${agentId}-${Date.now()}`;
	activityLogger?.logStreamStart(streamMsgId, agent.name);

	let timeoutId: Timer | undefined;

	try {
		const sessions = await runtime.spawn([
			{
				id: agent.name,
				role: agent.role,
				roleSource: "library",
				task: agent.task,
				profileId: agent.profileId,
			},
		]);
		const session = sessions[0];

		// Set up timeout
		if (timeoutMs > 0) {
			timeoutId = setTimeout(() => {
				session.abort({ reason: `Agent "${agent.name}" timed out after ${timeoutMs}ms` });
			}, timeoutMs);
		}

		const result = await session.wait();

		const status = result.exitCode === 0 ? ("completed" as const) : ("failed" as const);
		await stateTracker.updateAgent(agent.name, {
			status,
			completedAt: Date.now(),
			error: result.error,
		});
		await stateTracker.appendLog(
			agent.name,
			`Iteration ${iteration} ${status}${result.error ? `: ${result.error}` : ""}`,
		);

		activityLogger?.logStreamEnd(streamMsgId, agent.name, result.output, undefined);
		return result;
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
		stateTracker
			.updateAgent(agent.name, {
				status: "failed",
				completedAt: Date.now(),
				error: isTimeout ? `Timed out after ${timeoutMs}ms` : error,
			})
			.catch(() => {});
		stateTracker
			.appendLog(agent.name, `Iteration ${iteration} ${isTimeout ? "timed out" : "error"}: ${error}`)
			.catch(() => {});
		activityLogger?.logStreamEnd(streamMsgId, agent.name, `[Error] ${error}`, undefined);

		const failResult: SingleResult = {
			index,
			id: agentId,
			agent: agent.name,
			agentSource: "project" as AgentSource,
			task: agent.task,
			exitCode: 1,
			output: "",
			stderr: error,
			truncated: false,
			durationMs: 0,
			tokens: 0,
			requests: 0,
			error: isTimeout ? `Timed out after ${timeoutMs}ms` : error,
		};
		return failResult;
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}
