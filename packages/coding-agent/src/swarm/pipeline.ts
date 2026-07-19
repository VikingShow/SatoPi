/**
 * Pipeline controller for swarm execution.
 *
 * Orchestrates execution waves within each iteration:
 * - Agents in the same wave execute in parallel
 * - Waves execute sequentially (wave N+1 starts after wave N completes)
 * - For pipeline mode, iterations repeat the full DAG execution
 */
import type { AgentProgress, AgentSource, ModelRegistry, Settings, SingleResult } from "@oh-my-pi/pi-coding-agent";
import type { AgentExecutor } from "./executor";
import { executeSwarmAgent } from "./executor";
import type { SwarmDefinition } from "./schema";
import type { StateTracker } from "./state";

// ============================================================================
// Types
// ============================================================================

export interface PipelineOptions {
	workspace: string;
	signal?: AbortSignal;
	onProgress?: (state: PipelineProgress) => void;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
	/**
	 * P1-2: Custom agent executor. When provided, all agents use this
	 * executor instead of the default subprocess-based one.
	 */
	executor?: AgentExecutor;
	/**
	 * P1-6: Pipeline lifecycle hooks. Callers can inject custom behavior
	 * at key lifecycle points without modifying the pipeline controller.
	 */
	hooks?: PipelineHooks;
}

export interface PipelineProgress {
	iteration: number;
	targetCount: number;
	currentWave: number;
	totalWaves: number;
	agents: Record<string, { status: string; iteration: number }>;
}

export interface PipelineResult {
	status: "completed" | "failed" | "aborted";
	iterations: number;
	agentResults: Map<string, SingleResult[]>;
	errors: string[];
}

// ============================================================================
// P1-4: Wave-level structured context — data pipeline between waves
// ============================================================================

/**
 * Accumulated context from a completed wave, available to the next wave.
 * Agents in wave N+1 can inspect the results and outputs of wave N.
 */
export interface WaveResult {
	/** Wave index (0-based). */
	waveIdx: number;
	/** Agent names in this wave. */
	agents: string[];
	/** Per-agent execution results. */
	results: Map<string, SingleResult>;
	/** Agents that failed (non-zero exit code). */
	failedAgents: string[];
	/** Agents that succeeded (exit code 0). */
	successfulAgents: string[];
}

/**
 * Context passed between waves and iterations.
 * Accumulates across the entire pipeline run.
 */
export interface PipelineContext {
	/** All completed wave results, in execution order. */
	waves: WaveResult[];
	/** Aggregate token usage across all agents so far. */
	totalTokens: number;
	/** Aggregate request count across all agents so far. */
	totalRequests: number;
}

// ============================================================================
// P1-6: Pipeline lifecycle hooks
// ============================================================================

/**
 * Injectable lifecycle hooks for PipelineController.
 *
 * Hooks are called at key points in the pipeline lifecycle. Hook failures
 * are logged but never crash the pipeline — the error is collected via
 * `onHookError` and execution continues.
 */
export interface PipelineHooks {
	/** Called before the first iteration starts. */
	beforePipeline?: (ctx: PipelineContext) => Promise<void>;
	/** Called before each iteration. Return false to skip the iteration. */
	beforeIteration?: (iteration: number, ctx: PipelineContext) => Promise<boolean | void>;
	/** Called after each iteration completes. */
	afterIteration?: (iteration: number, ctx: PipelineContext) => Promise<void>;
	/** Called before each wave executes. Return false to skip the wave. */
	beforeWave?: (waveIdx: number, agents: string[], ctx: PipelineContext) => Promise<boolean | void>;
	/** Called after each wave completes. */
	afterWave?: (waveIdx: number, waveResult: WaveResult, ctx: PipelineContext) => Promise<void>;
	/** Called on pipeline completion (all iterations done). */
	afterPipeline?: (status: PipelineResult["status"], ctx: PipelineContext) => Promise<void>;
	/** Called when a hook throws. Receives the hook name and error. */
	onHookError?: (hookName: string, error: unknown) => void;
}

// ============================================================================
// Controller
// ============================================================================

export class PipelineController {
	#def: SwarmDefinition;
	#waves: string[][];
	#stateTracker: StateTracker;
	/** Active per-agent abort controllers keyed by agent name. */
	#activeControllers: Map<string, AbortController> = new Map();
	/** Accumulated iteration count across the run (survives fatal errors). */
	#completedIterations = 0;

	constructor(def: SwarmDefinition, waves: string[][], stateTracker: StateTracker) {
		this.#def = def;
		this.#waves = waves;
		this.#stateTracker = stateTracker;
	}

	/** The swarm definition — accessible to subclasses like LoopController. */
	protected get def(): SwarmDefinition {
		return this.#def;
	}

	/** The state tracker — accessible to subclasses like LoopController. */
	protected get stateTracker(): StateTracker {
		return this.#stateTracker;
	}

	/**
	 * Abort all currently running agents.
	 * Called on pipeline abort / fatal error / shutdown.
	 */
	abortAll(reason: string): void {
		for (const [name, controller] of this.#activeControllers) {
			try {
				controller.abort(new DOMException(reason, "AbortError"));
			} catch {
				// Controller may already be aborted — ignore.
			}
		}
		this.#activeControllers.clear();
	}

	async run(options: PipelineOptions): Promise<PipelineResult> {
		const { workspace, signal, onProgress, modelRegistry, settings, executor, hooks } = options;
		const allResults = new Map<string, SingleResult[]>();
		const errors: string[] = [];

		// P1-4: Accumulate wave context for inter-wave data flow.
		const pipelineCtx: PipelineContext = { waves: [], totalTokens: 0, totalRequests: 0 };

		for (const name of this.#def.agents.keys()) {
			allResults.set(name, []);
		}

		const targetCount = this.#def.targetCount;

		await this.#stateTracker.appendOrchestratorLog(
			`Pipeline '${this.#def.name}' starting: mode=${this.#def.mode} iterations=${targetCount} waves=${this.#waves.length} agents=${this.#def.agents.size}`,
		);

		// P1-6: beforePipeline hook.
		await invokeHook(hooks, "beforePipeline", () => hooks?.beforePipeline?.(pipelineCtx));

		try {
			for (let iteration = 0; iteration < targetCount; iteration++) {
				if (signal?.aborted) {
					await this.#stateTracker.updatePipeline({ status: "aborted" });
					return { status: "aborted", iterations: iteration, agentResults: allResults, errors };
				}

				// P1-6: beforeIteration hook — can skip.
				const shouldRun = await invokeHook(hooks, "beforeIteration", () =>
					hooks?.beforeIteration?.(iteration, pipelineCtx),
				);
				if (shouldRun === false) continue;

				await this.#stateTracker.updatePipeline({ iteration });
				await this.#stateTracker.appendOrchestratorLog(`--- Iteration ${iteration + 1}/${targetCount} ---`);

				const emitProgress = (currentWave: number) => {
					onProgress?.({
						iteration,
						targetCount,
						currentWave,
						totalWaves: this.#waves.length,
						agents: this.#buildProgressSnapshot(),
					});
				};

				const iterationResults = await this.#runIteration(iteration, {
					workspace,
					signal,
					emitProgress,
					modelRegistry,
					settings,
					executor,
					hooks,
					pipelineCtx,
				});

				for (const [agentName, result] of iterationResults) {
					allResults.get(agentName)!.push(result);
					if (result.exitCode !== 0) {
						errors.push(
							`${agentName} (iteration ${iteration + 1}): ${result.error || `exit code ${result.exitCode}`}`,
						);
					}
				}

				this.#completedIterations = iteration + 1;

				// P1-6: afterIteration hook.
				await invokeHook(hooks, "afterIteration", () =>
					hooks?.afterIteration?.(iteration, pipelineCtx),
				);
			}

			const status = errors.length > 0 ? ("failed" as const) : ("completed" as const);
			await this.#stateTracker.updatePipeline({ status, completedAt: Date.now() });
			await this.#stateTracker.appendOrchestratorLog(`Pipeline ${status} (${errors.length} errors)`);

			// P1-6: afterPipeline hook.
			await invokeHook(hooks, "afterPipeline", () => hooks?.afterPipeline?.(status, pipelineCtx));

			return { status, iterations: targetCount, agentResults: allResults, errors };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			// P0-2: Abort all still-running agents on fatal error.
			this.abortAll(`Pipeline fatal error: ${error}`);
			await this.#stateTracker.updatePipeline({ status: "failed", completedAt: Date.now() });
			await this.#stateTracker.appendOrchestratorLog(`Pipeline fatal error: ${error}`);
			errors.push(error);
			// P0-3: Preserve accumulated results from completed iterations.
			return {
				status: "failed",
				iterations: this.#completedIterations,
				agentResults: allResults,
				errors,
			};
		}
	}

	async #runIteration(
		iteration: number,
		options: {
			workspace: string;
			signal?: AbortSignal;
			emitProgress: (currentWave: number) => void;
			modelRegistry?: ModelRegistry;
			settings?: Settings;
			executor?: AgentExecutor;
			hooks?: PipelineHooks;
			pipelineCtx: PipelineContext;
		},
	): Promise<Map<string, SingleResult>> {
		const { hooks, pipelineCtx, executor } = options;
		const results = new Map<string, SingleResult>();
		let agentIndex = 0;

		for (let waveIdx = 0; waveIdx < this.#waves.length; waveIdx++) {
			const wave = this.#waves[waveIdx];

			if (options.signal?.aborted) break;

			// P1-6: beforeWave hook — can skip.
			const shouldRun = await invokeHook(hooks, "beforeWave", () =>
				hooks?.beforeWave?.(waveIdx, wave, pipelineCtx),
			);
			if (shouldRun === false) continue;

			await this.#stateTracker.appendOrchestratorLog(
				`Wave ${waveIdx + 1}/${this.#waves.length}: [${wave.join(", ")}]`,
			);

			// Mark agents in this wave as waiting
			for (const agentName of wave) {
				await this.#stateTracker.updateAgent(agentName, {
					status: "waiting",
					iteration,
					wave: waveIdx,
				});
			}
			options.emitProgress(waveIdx);

			// Execute all agents in wave in parallel, catching per-agent errors
			const waveResults = await Promise.all(
				wave.map(async agentName => {
					const agent = this.#def.agents.get(agentName)!;
					const currentIndex = agentIndex++;
					try {
						const result = await executeSwarmAgent(agent, currentIndex, {
							workspace: options.workspace,
							swarmName: this.#def.name,
							iteration,
							modelOverride: agent.model ?? this.#def.model,
							signal: options.signal,
							onProgress: (_name: string, _progress: AgentProgress) => {
								options.emitProgress(waveIdx);
							},
							modelRegistry: options.modelRegistry,
							settings: options.settings,
							stateTracker: this.#stateTracker,
							// P0-2: Register controller so the pipeline can abort this agent on shutdown.
							onStarted: controller => {
								this.#activeControllers.set(agentName, controller);
							},
							// P1-2: Inject custom executor if provided.
							executor,
						});
						return { agentName, result };
					} catch (err) {
						const error = err instanceof Error ? err.message : String(err);
						const failResult: SingleResult = {
							index: currentIndex,
							id: `swarm-${this.#def.name}-${agentName}-${iteration}`,
							agent: agentName,
							agentSource: "project" as AgentSource,
							task: agent.task,
							exitCode: 1,
							output: "",
							stderr: error,
							truncated: false,
							durationMs: 0,
							tokens: 0,
							requests: 0,
							error,
						};
						return { agentName, result: failResult };
					} finally {
						// P0-2: Clean up controller reference after agent completes or fails.
						this.#activeControllers.delete(agentName);
					}
				}),
			);

			for (const { agentName, result } of waveResults) {
				results.set(agentName, result);
			}

			// P1-4: Build WaveResult for inter-wave data flow.
			const waveResult: WaveResult = {
				waveIdx,
				agents: [...wave],
				results: new Map(waveResults.map(wr => [wr.agentName, wr.result] as const)),
				failedAgents: waveResults.filter(wr => wr.result.exitCode !== 0).map(wr => wr.agentName),
				successfulAgents: waveResults.filter(wr => wr.result.exitCode === 0).map(wr => wr.agentName),
			};
			waveResult.results.forEach(r => {
				pipelineCtx.totalTokens += r.tokens;
				pipelineCtx.totalRequests += r.requests;
			});
			pipelineCtx.waves.push(waveResult);

			// P1-6: afterWave hook.
			await invokeHook(hooks, "afterWave", () =>
				hooks?.afterWave?.(waveIdx, waveResult, pipelineCtx),
			);

			options.emitProgress(waveIdx);
		}

		return results;
	}

	#buildProgressSnapshot(): Record<string, { status: string; iteration: number }> {
		const snapshot: Record<string, { status: string; iteration: number }> = {};
		for (const [name, agent] of Object.entries(this.#stateTracker.state.agents)) {
			snapshot[name] = { status: agent.status, iteration: agent.iteration };
		}
		return snapshot;
	}
}

// ============================================================================
// P1-6: Hook invocation helper
// ============================================================================

/**
 * Safely invoke a lifecycle hook.
 * Hook errors are forwarded to `onHookError` and never propagate.
 */
async function invokeHook<T>(
	hooks: PipelineHooks | undefined,
	name: string,
	fn: () => Promise<T> | T | undefined,
): Promise<T | undefined> {
	if (!hooks) return undefined;
	try {
		return await fn();
	} catch (err) {
		try {
			hooks?.onHookError?.(name, err);
		} catch {
			// onHookError itself threw — swallow.
		}
		return undefined;
	}
}
