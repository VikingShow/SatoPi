/**
 * Pipeline controller for swarm execution.
 *
 * Orchestrates execution waves within each iteration:
 * - Agents in the same wave execute in parallel
 * - Waves execute sequentially (wave N+1 starts after wave N completes)
 * - For pipeline mode, iterations repeat the full DAG execution
 */
import type { AgentSource, ModelRegistry, Settings, SingleResult } from "@oh-my-pi/pi-coding-agent";
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
		const { workspace, signal, onProgress, modelRegistry, settings } = options;
		const allResults = new Map<string, SingleResult[]>();
		const errors: string[] = [];

		for (const name of this.#def.agents.keys()) {
			allResults.set(name, []);
		}

		const targetCount = this.#def.targetCount;

		await this.#stateTracker.appendOrchestratorLog(
			`Pipeline '${this.#def.name}' starting: mode=${this.#def.mode} iterations=${targetCount} waves=${this.#waves.length} agents=${this.#def.agents.size}`,
		);

		try {
			for (let iteration = 0; iteration < targetCount; iteration++) {
				if (signal?.aborted) {
					await this.#stateTracker.updatePipeline({ status: "aborted" });
					return { status: "aborted", iterations: iteration, agentResults: allResults, errors };
				}

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
			}

			const status = errors.length > 0 ? ("failed" as const) : ("completed" as const);
			await this.#stateTracker.updatePipeline({ status, completedAt: Date.now() });
			await this.#stateTracker.appendOrchestratorLog(`Pipeline ${status} (${errors.length} errors)`);
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
		},
	): Promise<Map<string, SingleResult>> {
		const results = new Map<string, SingleResult>();
		let agentIndex = 0;

		for (let waveIdx = 0; waveIdx < this.#waves.length; waveIdx++) {
			const wave = this.#waves[waveIdx];

			if (options.signal?.aborted) break;

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
							onProgress: (_name, _progress) => {
								options.emitProgress(waveIdx);
							},
							modelRegistry: options.modelRegistry,
							settings: options.settings,
							stateTracker: this.#stateTracker,
							// P0-2: Register controller so the pipeline can abort this agent on shutdown.
							onStarted: controller => {
								this.#activeControllers.set(agentName, controller);
							},
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
