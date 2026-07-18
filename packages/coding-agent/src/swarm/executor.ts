/**
 * Swarm agent execution via oh-my-pi's subagent infrastructure.
 *
 * Wraps `runSubprocess` to spawn individual swarm agents with full tool access.
 * Each agent runs in the swarm workspace with its task instructions as the user prompt.
 */
import * as path from "node:path";
import type {
	AgentDefinition,
	AgentProgress,
	AgentSource,
	ModelRegistry,
	Settings,
	SingleResult,
} from "@oh-my-pi/pi-coding-agent";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent";
import type { SwarmAgent } from "./schema";
import type { StateTracker } from "./state";

/** Default per-agent wall-clock cap (5 minutes). */
const DEFAULT_AGENT_TIMEOUT_MS = 5 * 60 * 1000;

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
}

/**
 * Execute a single swarm agent as an oh-my-pi subagent.
 *
 * The agent receives:
 * - System prompt: built from role + extra_context
 * - User prompt (task): the full task instructions from the YAML
 * - Working directory: the swarm workspace
 * - Full tool access (bash, python, read, write, edit, grep, find, fetch, web_search, browser)
 */
export async function executeSwarmAgent(
	agent: SwarmAgent,
	index: number,
	options: SwarmExecutorOptions,
): Promise<SingleResult> {
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
	} = options;

	const agentId = `swarm-${swarmName}-${agent.name}-${iteration}`;

	const agentDef: AgentDefinition = {
		name: agent.name,
		description: `Swarm agent: ${agent.role}`,
		systemPrompt: buildSystemPrompt(agent),
		source: "project" as AgentSource,
	};

	// Build a per-agent timeout controller and combine with the caller's signal.
	// The caller can terminate the agent via onStarted's controller.
	const agentController = new AbortController();
	const effectiveSignal =
		signal && timeoutMs > 0
			? AbortSignal.any([signal, agentController.signal])
			: signal ?? agentController.signal;

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
			onProgress: progress => onProgress?.(agent.name, progress),
			modelRegistry,
			settings,
			enableLsp: false,
			artifactsDir: path.join(stateTracker.swarmDir, "context"),
			keepAlive: false,
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
		await stateTracker.appendLog(
			agent.name,
			`Iteration ${iteration} ${isTimeout ? "timed out" : "error"}: ${error}`,
		);

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
