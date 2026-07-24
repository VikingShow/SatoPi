/**
 * Swarm agent execution via oh-my-pi's subagent infrastructure.
 *
 * Wraps `runSubprocess` to spawn individual swarm agents with full tool access.
 * Each agent runs in the swarm workspace with its task instructions as the user prompt.
 *
 * ## Extensibility
 *
 * The `AgentExecutor` interface allows callers to inject custom execution
 * strategies (e.g. remote agents, HTTP-triggered agents) without modifying
 * the pipeline controller.
 */
import * as path from "node:path";
import type { AgentLoopConfig } from "@oh-my-pi/pi-agent-core";
import type {
	AgentDefinition,
	AgentProgress,
	AgentSource,
	ModelRegistry,
	Settings,
	SingleResult,
} from "@oh-my-pi/pi-coding-agent";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent";
import type { SwarmAgent } from "../core/schema";
import type { StateTracker } from "../core/state";
import type { ActivityLogger } from "../hooks/activity-logger";
import { createStreamProgressHandler } from "../render/streaming";

/** Default per-agent wall-clock cap (5 minutes). */
const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================================
// P1-2: Agent Executor Interface — decouples execution strategy from pipeline
// ============================================================================

/**
 * Injectable agent execution strategy.
 *
 * The default implementation (`SubprocessAgentExecutor`) spawns a local
 * subprocess via `runSubprocess`. Callers can inject a custom executor
 * through `SwarmExecutorOptions.executor` to support remote agents,
 * sandboxed environments, or testing mocks.
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
	 * Callback invoked after the subprocess has started.
	 * Receives an AbortController that the caller can use to
	 * terminate the agent externally (e.g. on pipeline abort).
	 */
	onStarted?: (controller: AbortController) => void;
	/**
	 * Custom executor override. When provided the pipeline uses this
	 * instead of the default `SubprocessAgentExecutor`.
	 */
	executor?: AgentExecutor;
	/**
	 * Optional tool hooks passed through to the subprocess's AgentLoopConfig.
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
}

// ============================================================================
// Default executor — spawns a local oh-my-pi subprocess
// ============================================================================

/**
 * Default agent executor: spawns a local oh-my-pi subprocess.
 *
 * The agent receives:
 * - System prompt: built from role + extra_context
 * - User prompt (task): the full task instructions from the YAML
 * - Working directory: the swarm workspace
 * - Tool access: configurable via SwarmAgent.allowedTools / blockedTools
 */
export class SubprocessAgentExecutor implements AgentExecutor {
	async execute(agent: SwarmAgent, index: number, options: SwarmExecutorOptions): Promise<SingleResult> {
		return executeSwarmAgent(agent, index, options);
	}
}

/** Shared singleton to avoid re-allocating. */
const defaultExecutor = new SubprocessAgentExecutor();

/**
 * Execute a single swarm agent as an oh-my-pi subagent.
 *
 * Used by both SubprocessAgentExecutor and PipelineController.
 */
export async function executeSwarmAgent(
	agent: SwarmAgent,
	index: number,
	options: SwarmExecutorOptions,
): Promise<SingleResult> {
	// Delegate to custom executor if provided.
	if (options.executor && options.executor !== defaultExecutor) {
		return options.executor.execute(agent, index, options);
	}

	const {
		workspace,
		swarmName,
		iteration,
		modelOverride,
		signal,
		onProgress,
		modelRegistry,
		settings,
		stateTracker,
		timeoutMs = DEFAULT_AGENT_TIMEOUT_MS,
		onStarted,
		toolHooks,
		agentOverrides,
			activityLogger,
	} = options;

	const agentId = `swarm-${swarmName}-${agent.name}-${iteration}`;

	// P1-5: Pass tool restrictions from SwarmAgent schema to AgentDefinition.
	const agentDef: AgentDefinition = {
		name: agent.name,
		description: `Swarm agent: ${agent.role}`,
		systemPrompt: buildSystemPrompt(agent),
		source: "project" as AgentSource,
		...(agent.allowedTools ? { tools: agent.allowedTools } : {}),
		...(agent.blockedTools ? { blockedTools: agent.blockedTools } : {}),
		// Merge caller-provided AgentDefinition overrides (systemPrompt, tools, blockedTools, source, etc.).
		...agentOverrides,
	};

	// Build a per-agent timeout controller and combine with the caller's signal.
	// The caller can terminate the agent via onStarted's controller.
	const agentController = new AbortController();
	const effectiveSignal =
		signal && timeoutMs > 0 ? AbortSignal.any([signal, agentController.signal]) : (signal ?? agentController.signal);

	// Arm the timeout if enabled.
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	if (timeoutMs > 0) {
		timeoutId = setTimeout(() => {
			agentController.abort(
				new DOMException(`Agent "${agent.name}" timed out after ${timeoutMs}ms`, "TimeoutError"),
			);
		}, timeoutMs);
	}

	// Notify the caller so they can abort us on pipeline shutdown.
	onStarted?.(agentController);

	await stateTracker.updateAgent(agent.name, {
		status: "running",
		iteration,
		startedAt: Date.now(),
	});
	await stateTracker.appendLog(agent.name, `Starting iteration ${iteration}`);

			// SSE streaming: signal the frontend that this agent has started producing output.
			const streamMsgId = `${agentId}-${Date.now()}`;
			activityLogger?.logStreamStart(streamMsgId, agent.name);

	try {
		const result = await runSubprocess({
			cwd: workspace,
			agent: agentDef,
			task: agent.task,
			index,
			id: agentId,
			modelOverride,
			signal: effectiveSignal,
			maxRuntimeMs: timeoutMs > 0 ? timeoutMs : undefined,
				onProgress: activityLogger
					? createStreamProgressHandler(activityLogger, streamMsgId, agent.name,
						(progress) => onProgress?.(agent.name, progress))
					: (progress: AgentProgress) => onProgress?.(agent.name, progress),
			modelRegistry,
			settings,
			enableLsp: false,
			artifactsDir: path.join(stateTracker.swarmDir, "context"),
			keepAlive: false,
			beforeToolCall: toolHooks?.beforeToolCall,
			afterToolCall: toolHooks?.afterToolCall,
		});

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

			activityLogger?.logStreamEnd(streamMsgId, agent.name, result.output, result.thinking);
		return result;
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		// Distinguish timeout from other failures.
		const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
		const status = isTimeout ? ("failed" as const) : ("failed" as const);
		await stateTracker.updateAgent(agent.name, {
			status,
			completedAt: Date.now(),
			error: isTimeout ? `Timed out after ${timeoutMs}ms` : error,
		});
		await stateTracker.appendLog(agent.name, `Iteration ${iteration} ${isTimeout ? "timed out" : "error"}: ${error}`);
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

function buildSystemPrompt(agent: SwarmAgent): string {
	const parts = [`You are a ${agent.role}.`];
	if (agent.extraContext) {
		parts.push(agent.extraContext);
	}
	return parts.join("\n\n");
}
