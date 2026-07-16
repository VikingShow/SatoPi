import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { logger } from "@oh-my-pi/pi-utils";
import type { PipelineOptions } from "./pipeline";
import { ClonerCouncil, type ReviewVerdict } from "./roundtable";
import type { LoopSwarmConfig } from "./schema";
import type { StateTracker } from "./state";
import { TaskComplexityAnalyzer } from "./task-analyzer";
import { WorkerChannel } from "./worker-channel";

// ============================================================================
// Types
// ============================================================================

export interface LoopOptions extends PipelineOptions {
	loopConfig: LoopSwarmConfig;
	ircBus?: IrcBus;
	clonerAgentId?: string;
	/** plan.md content from the Before Loop phase. Injected into worker + cloner prompts. */
	planContent?: string;
	/** Tracks agent status for TUI progress widget. */
	stateTracker: StateTracker;
}

export interface LoopResult {
	status: "completed" | "failed" | "aborted" | "escalated" | "converged_failed" | "converged_partial";
	iterations: number;
	reviewVerdicts: ReviewVerdict[];
	errors: string[];
	/** When status is "escalated", carries context for human decision. */
	escalationContext?: {
		lastWorkerOutput: string;
		lastFindings: string[];
		approvalRatio: number;
	};
}

// ============================================================================
// Prompts
// ============================================================================

const WORKER_SYSTEM_PROMPT = `\
You are a Worker in the Loop Engineering system — part of a self-organizing swarm.
You collaborate with other Workers to complete a task defined in a plan that will be provided.

MECHANISM:
- A plan.md containing the goal, constraints, and acceptance criteria is broadcast.
- You and other Workers negotiate via group chat (WorkerChannel) how to divide the work.
  No one assigns tasks to you — you self-organize through open discussion.
- You can broadcast to all Workers, create sub-groups, and elect roles (reviewer, integrator, etc.).
- After each round, you receive prior rounds' outputs for cross-examination.
- The swarm runs multiple rounds per iteration — review peers' work, spot issues, refine together.
- Workers can declare convergence via IRC when the output stabilizes.

PEER REVIEW (critical):
- In round 2+, you MUST cross-examine prior round outputs.
- Flag gaps, contradictions, and quality issues you find in your peers' work.
- If you see duplicated effort, coordinate to merge.
- If a peer's output is wrong or substandard, say so — be direct, not polite.
- This internal review is your primary quality mechanism. Cloners are latent guardians
  who only intervene when the swarm cannot resolve its own disagreements.

YOUR CAPABILITIES:
- Full tool access: read, write, edit, bash, grep, glob, web_search, browser
- Communicate with other Workers via irc (use \`irc send\` with to:"worker:*" for broadcast)
- Write output to the workspace directory

BEHAVIOR:
- Proactively negotiate — don't wait to be told what to do.
- If another Worker is duplicating your work, coordinate with them.
- If you're blocked, broadcast for help.
- Before finishing a round, self-audit your output against the plan's acceptance criteria.
- Record what you did and what you learned.
- Always produce verifiable output in the workspace.`;

// ============================================================================
// Similarity helpers
// ============================================================================

/** Jaccard similarity between two arrays of tokens. Returns 0–1. */
function jaccardSimilarity(a: string[], b: string[]): number {
	const setA = new Set(a);
	const setB = new Set(b);
	if (setA.size === 0 && setB.size === 0) return 1;
	let intersection = 0;
	for (const item of setA) {
		if (setB.has(item)) intersection++;
	}
	const union = new Set([...setA, ...setB]).size;
	return union === 0 ? 0 : intersection / union;
}

/** Compute Jaccard similarity between two sets of findings. */
function findingsSimilarity(prev: string[], curr: string[]): number {
	const prevTokens = prev.flatMap(f => f.toLowerCase().split(/[^a-z0-9]+/)).filter(t => t.length > 2);
	const currTokens = curr.flatMap(f => f.toLowerCase().split(/[^a-z0-9]+/)).filter(t => t.length > 2);
	return jaccardSimilarity(prevTokens, currTokens);
}

// ============================================================================
// Controller
export class LoopController {
	readonly #loopConfig: LoopSwarmConfig;
	readonly #ircBus: IrcBus;
	readonly #clonerId: string;
	readonly #stateTracker: StateTracker;
	#channel?: WorkerChannel;

	constructor(options: LoopOptions) {
		this.#loopConfig = options.loopConfig;
		this.#ircBus = options.ircBus ?? IrcBus.global();
		this.#clonerId = options.clonerAgentId ?? MAIN_AGENT_ID;
		this.#stateTracker = options.stateTracker;
	}

	async runLoop(options: PipelineOptions & { planContent?: string }): Promise<LoopResult> {
		const verdicts: ReviewVerdict[] = [];
		const errors: string[] = [];
		const clonerFeedbackHistory: string[] = [];
		// Convergence tracking
		const convergenceThreshold = this.#loopConfig.convergenceThreshold;
		let stagnationCount = 0;
		let lastFindingsKey = "";
		// Dynamic worker tracking
		// Per-iteration role suggestions from cloner review (Round 2+).
		let currentRoleSuggestions: Record<string, string> = {};
		let currentWorkerCount = this.#loopConfig.workers.initial;
		let currentMaxRounds = this.#loopConfig.workers.maxRounds;
		let currentConvergenceNeeded = this.#loopConfig.workers.roundsConvergenceThreshold;
		const workerIds: string[] = [];
		let clonerIds: string[] = [];
		const { workspace, modelRegistry, settings, signal, planContent } = options;

		// TaskComplexityAnalyzer: override worker count, maxRounds, and convergence
		// based on plan.md content when workers.auto is enabled.
		if (this.#loopConfig.workers.auto && planContent) {
			const analyzer = new TaskComplexityAnalyzer(modelRegistry!, settings!);
			const rec = await analyzer.analyze(planContent, this.#loopConfig);
			currentWorkerCount = rec.workers;
			currentMaxRounds = rec.maxRounds;
			currentConvergenceNeeded = rec.roundsConvergenceThreshold;
			logger.info("TaskComplexityAnalyzer override", {
				workers: rec.workers,
				maxRounds: rec.maxRounds,
				convergenceNeeded: rec.roundsConvergenceThreshold,
				rationale: rec.rationale,
				complexity: rec.complexity,
			});
		}

		const initialWorkerCount = currentWorkerCount;
		const clonerCount = this.#loopConfig.cloners.count;

		// Initialize worker and cloner IDs
		for (let i = 0; i < initialWorkerCount; i++) workerIds.push(`worker-${i + 1}`);
		clonerIds = Array.from({ length: clonerCount }, (_, i) => `cloner-${i + 1}`);

		this.#channel = new WorkerChannel(this.#ircBus, {
			workers: workerIds,
			cloners: clonerIds,
		});
		await this.#channel.broadcast(
			this.#clonerId,
			`Plan broadcast. Workers: ${initialWorkerCount}, Cloners: ${clonerCount}.`,
		);

		for (let iter = 0; iter < this.#loopConfig.maxIterations; iter++) {
			if (signal?.aborted) {
				return {
					status: "aborted",
					iterations: iter,
					reviewVerdicts: verdicts,
					errors,
				};
			}

			// Per-iteration timeout: create a combined signal
			const iterationTimeout = this.#loopConfig.iterationTimeoutMs;
			let iterSignal = signal;
			if (iterationTimeout > 0) {
				const timeoutController = new AbortController();
				const timer = setTimeout(
					() => timeoutController.abort(new DOMException("iteration timeout", "TimeoutError")),
					iterationTimeout,
				);
				iterSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
				// Clean up timer after iteration completes or times out
				const cleanup = () => clearTimeout(timer);
				if (signal) signal.addEventListener("abort", cleanup, { once: true });
				timeoutController.signal.addEventListener("abort", cleanup, { once: true });
			}

			// Progress: workers running
			for (const id of workerIds) {
				await this.#stateTracker.updateAgent(id, { status: "running", iteration: iter });
			}
			await this.#stateTracker.updatePipeline({ loopIteration: iter + 1, roundtablePhase: "Workers executing" });
			options.onProgress?.({
				iteration: iter,
				targetCount: this.#loopConfig.maxIterations,
				currentWave: 0,
				totalWaves: 1,
				agents: Object.fromEntries(workerIds.map(id => [id, { status: "running", iteration: iter }])),
			});

			let verdict: ReviewVerdict | null = null;
			let lastWorkerOutput = "";
			let workersConverged = false;
			try {
				const maxRounds = currentMaxRounds;
				const convergenceNeeded = currentConvergenceNeeded;
				// 0 = unlimited; safety cap at 10 rounds
				const hardLimit = maxRounds === 0 ? 10 : maxRounds;
				const allWorkerResults: SingleResult[] = [];
				let priorOutputs = "";
				let convergenceStreak = 0;
				let lastRoundOutputsKey = "";

				for (let round = 0; round < hardLimit; round++) {
					if (iterSignal?.aborted) break;

					const roundLabel =
						maxRounds === 0
							? `Workers round ${round + 1} (convergence-driven)`
							: `Workers round ${round + 1}/${hardLimit}`;
					await this.#stateTracker.updatePipeline({ roundtablePhase: roundLabel });
					for (const id of workerIds) {
						await this.#stateTracker.updateAgent(id, { status: "running", iteration: iter });
					}
					options.onProgress?.({
						iteration: iter,
						targetCount: this.#loopConfig.maxIterations,
						currentWave: 0,
						totalWaves: 1,
						agents: Object.fromEntries(workerIds.map(id => [id, { status: "running", iteration: iter }])),
					});

					// Build roundtable context — inject prior outputs for rounds > 0
					let extraContext = "";
					if (round > 0) {
						const prompt = this.#loopConfig.workers.roundtablePrompt
							? `\n${this.#loopConfig.workers.roundtablePrompt}\n`
							: `\n## Prior Round Outputs\n\nCross-examine these outputs. Flag gaps, contradictions, and quality issues. Be direct — your peers expect honest critique. Refine and improve upon the prior work.\n`;
						extraContext = `${prompt}\n${priorOutputs}`;
					}
					const roundResults = await this.#spawnWorkers(
						workerIds,
						workspace,
						planContent,
						clonerFeedbackHistory,
						modelRegistry,
						settings,
						iterSignal,
						errors,
						extraContext,
						currentRoleSuggestions,
					);

					if (iterSignal?.aborted) {
						return {
							status: "aborted",
							iterations: iter + 1,
							reviewVerdicts: verdicts,
							errors,
						};
					}

					allWorkerResults.push(...roundResults);

					// Build prior outputs for next round
					priorOutputs = roundResults.map(r => `[${r.agent}] ${r.output.slice(0, 2000)}`).join("\n\n---\n\n");

					// Convergence detection on worker outputs (not cloner findings)
					if (round > 0 && convergenceNeeded > 0) {
						const currKey = roundResults
							.map(r => r.output.slice(0, 500))
							.sort()
							.join("||");
						const similarity = lastRoundOutputsKey
							? findingsSimilarity(lastRoundOutputsKey.split("||"), currKey.split("||"))
							: 0;
						lastRoundOutputsKey = currKey;

						if (similarity >= 0.85) {
							convergenceStreak++;
							if (convergenceStreak >= convergenceNeeded) {
								workersConverged = true;
								break;
							}
						} else {
							convergenceStreak = 0;
						}
					} else {
						lastRoundOutputsKey = roundResults
							.map(r => r.output.slice(0, 500))
							.sort()
							.join("||");
					}
				}

				// 3. Collect worker output for review context (all rounds)
				lastWorkerOutput = allWorkerResults.map(r => `[${r.agent}] ${r.output.slice(0, 4000)}`).join("\n\n---\n\n");

				// 4. Latent cloner gate: only review when workers failed to converge internally
				if (workersConverged) {
					// Workers converged — internal peer review sufficed. Skip cloner review.
					await this.#stateTracker.updatePipeline({
						roundtablePhase: "Workers converged internally",
						reviewVerdict: "swarm consensus",
					});
					options.onProgress?.({
						iteration: iter,
						targetCount: this.#loopConfig.maxIterations,
						currentWave: 0,
						totalWaves: 1,
						agents: Object.fromEntries(
							workerIds.map(id => [id, { status: "completed" as const, iteration: iter }]),
						),
					});
					return {
						status: "completed",
						iterations: iter + 1,
						reviewVerdicts: verdicts,
						errors,
					};
				}

				// Workers did not converge — escalate to latent cloner review
				await this.#channel.broadcast(
					this.#clonerId,
					`Swarm did not converge internally. Escalating to Cloner review (iteration ${iter + 1}).`,
				);

				// Progress: cloners reviewing
				for (const id of clonerIds) {
					await this.#stateTracker.updateAgent(id, { status: "running", iteration: iter });
				}
				await this.#stateTracker.updatePipeline({ roundtablePhase: "Cloners reviewing (escalation)" });
				options.onProgress?.({
					iteration: iter,
					targetCount: this.#loopConfig.maxIterations,
					currentWave: 0,
					totalWaves: 1,
					agents: Object.fromEntries(clonerIds.map(id => [id, { status: "running", iteration: iter }])),
				});

				// Spawn cloners to review (parallel)
				verdict = await this.#runClonerReview(
					clonerIds,
					iter,
					lastWorkerOutput,
					workspace,
					planContent,
					clonerFeedbackHistory,
					modelRegistry,
					settings,
					iterSignal,
				);

				verdicts.push(verdict);

				// Save role suggestions for next iteration's workers (GAP 1)
				if (Object.keys(verdict.roleSuggestions).length > 0) {
					currentRoleSuggestions = verdict.roleSuggestions;
				}

				// Track worker quality from cloner verdict (GAP 3)
				if (verdict.praisedWorkers.length > 0) {
					await this.#stateTracker.incrementPraise(verdict.praisedWorkers);
				}
				if (verdict.criticizedWorkers.length > 0) {
					await this.#stateTracker.incrementCriticism(verdict.criticizedWorkers);
				}

				// Progress: cloners completed
				for (const id of clonerIds) {
					await this.#stateTracker.updateAgent(id, {
						status: "completed",
						iteration: iter,
						completedAt: Date.now(),
					});
				}
				await this.#stateTracker.updatePipeline({
					roundtablePhase: verdict.passed ? "Passed" : "Reviewing findings",
					reviewVerdict: verdict.findings.slice(0, 3).join("; "),
				});
				options.onProgress?.({
					iteration: iter,
					targetCount: this.#loopConfig.maxIterations,
					currentWave: 0,
					totalWaves: 1,
					agents: Object.fromEntries([
						...workerIds.map(id => [id, { status: "completed" as const, iteration: iter }]),
						...clonerIds.map(id => [id, { status: "completed" as const, iteration: iter }]),
					]),
				});
				if (verdict.passed) {
					return {
						status: "completed",
						iterations: iter + 1,
						reviewVerdicts: verdicts,
						errors,
					};
				}
			} catch (err) {
				const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
				const message = isTimeout
					? `Iteration ${iter + 1} timed out after ${this.#loopConfig.iterationTimeoutMs}ms`
					: `Iteration ${iter + 1} error: ${err instanceof Error ? err.message : String(err)}`;
				errors.push(message);
				if (signal?.aborted) {
					return {
						status: "aborted",
						iterations: iter + 1,
						reviewVerdicts: verdicts,
						errors,
					};
				}
				// Timeout → skip to next iteration
				continue;
			}
			// No verdict (timed out before cloner review) — skip to next iteration
			if (!verdict) continue;

			// Convergence detection: Jaccard similarity on cloner findings
			if (convergenceThreshold > 0) {
				const prevFindings = lastFindingsKey ? lastFindingsKey.split("||") : [];
				const currFindings = verdict.findings;
				const similarity = prevFindings.length > 0 ? findingsSimilarity(prevFindings, currFindings) : 0;

				if (similarity >= 0.8) {
					stagnationCount++;
					if (stagnationCount >= convergenceThreshold) {
						// Exact match → full convergence failure
						if (similarity >= 1.0 || (similarity >= 0.95 && stagnationCount >= convergenceThreshold + 1)) {
							const result: LoopResult = {
								status: "converged_failed",
								iterations: iter + 1,
								reviewVerdicts: verdicts,
								errors: [
									...errors,
									`Converged after ${stagnationCount} near-identical review rounds (similarity: ${similarity.toFixed(2)})`,
								],
							};
							if (this.#loopConfig.humanEscalation) {
								result.escalationContext = {
									lastWorkerOutput,
									lastFindings: verdict.findings,
									approvalRatio: verdict.totalCount > 0 ? verdict.approvalCount / verdict.totalCount : 0,
								};
							}
							return result;
						}
						// High similarity but not identical → converged_partial
						return {
							status: "converged_partial",
							iterations: iter + 1,
							reviewVerdicts: verdicts,
							errors: [
								...errors,
								`Partially converged after ${stagnationCount} rounds (Jaccard: ${similarity.toFixed(2)})`,
							],
						};
					}
				} else {
					stagnationCount = 0;
				}
				lastFindingsKey = currFindings.sort().join("||");
			}
			// 5. Dynamic worker scaling with delta-based acceleration (GAP 2)
			//    When ≥2/3 cloners agree on direction and |delta| ≥ 2, jump by delta.
			//    Otherwise fall back to conservative ±1.
			const { min, max } = this.#loopConfig.workers;
			const suggestions = verdict.workerCountSuggestions;
			if (suggestions.length >= Math.ceil(clonerIds.length / 2)) {
				const upVotes = suggestions.filter(d => d > 0).length;
				const downVotes = suggestions.filter(d => d < 0).length;
				const superMajority = Math.ceil((clonerIds.length * 2) / 3);
				const majority = Math.ceil(clonerIds.length / 2);

				suggestions.sort((a, b) => a - b);
				const medianDelta = suggestions[Math.floor(suggestions.length / 2)];

				// Fast scaling: super-majority + ≥2 delta → jump
				// Conservative: simple majority → ±1
				let delta: number;
				if ((upVotes >= superMajority || downVotes >= superMajority) && Math.abs(medianDelta) >= 2) {
					delta = medianDelta;
				} else if (upVotes >= majority) {
					delta = 1;
				} else if (downVotes >= majority && currentWorkerCount > min) {
					delta = -1;
				} else {
					delta = 0;
				}

				if (delta > 0) {
					const addCount = Math.min(delta, max - currentWorkerCount);
					for (let i = 0; i < addCount; i++) {
						const newId = `worker-${workerIds.length + 1}`;
						this.#channel.addWorker(newId);
						await this.#stateTracker.registerAgent(newId);
						workerIds.push(newId);
						currentWorkerCount++;
					}
				} else if (delta < 0 && currentWorkerCount > min) {
					const removeCount = Math.min(-delta, currentWorkerCount - min);
					for (let i = 0; i < removeCount; i++) {
						// Quality-based scale-down: remove the lowest-scoring worker (GAP 3)
						const worst = this.#stateTracker.getWorstWorker(workerIds);
						const removed = worst ?? workerIds[workerIds.length - 1];
						const idx = workerIds.indexOf(removed);
						if (idx >= 0) workerIds.splice(idx, 1);
						this.#channel.removeWorker(removed);
						currentWorkerCount--;
					}
				}
			}

			// 6. Broadcast feedback and accumulate for cross-iteration memory
			const feedback = verdict.findings.join("\n");
			clonerFeedbackHistory.push(feedback);
			await this.#channel.broadcast(this.#clonerId, `Review feedback (iteration ${iter + 1}):\n${feedback}`);
			if (iter === this.#loopConfig.maxIterations - 1) {
				const status = this.#loopConfig.humanEscalation ? "escalated" : "failed";
				const result: LoopResult = {
					status,
					iterations: iter + 1,
					reviewVerdicts: verdicts,
					errors,
				};
				if (status === "escalated") {
					result.escalationContext = {
						lastWorkerOutput,
						lastFindings: verdict.findings,
						approvalRatio: verdict.totalCount > 0 ? verdict.approvalCount / verdict.totalCount : 0,
					};
				}
				return result;
			}
		}

		return {
			status: "completed",
			iterations: this.#loopConfig.maxIterations,
			reviewVerdicts: verdicts,
			errors,
		};
	}

	// -------------------------------------------------------------------
	// Spawn workers in parallel
	// -------------------------------------------------------------------
	async #spawnWorkers(
		workerIds: string[],
		workspace: string,
		planContent: string | undefined,
		previousFeedback: string[],
		modelRegistry?: ModelRegistry,
		settings?: Settings,
		signal?: AbortSignal,
		errors: string[] = [],
		extraContext?: string,
		roleSuggestions?: Record<string, string>,
	): Promise<SingleResult[]> {
		const feedbackBlock =
			previousFeedback.length > 0
				? `\n## Previous Review Feedback\n\n${previousFeedback.map((f, i) => `(Iteration ${i + 1}) ${f}`).join("\n")}\n`
				: "";

		const results = await Promise.allSettled(
			workerIds.map((id, i) =>
				runSubprocess({
					cwd: workspace,
					agent: {
						name: id,
						description: `Loop Engineering Worker ${i + 1}`,
						systemPrompt: WORKER_SYSTEM_PROMPT,
						source: "project",
					},
					task: [
						`You are Worker ${i + 1} of ${workerIds.length}.`,
						`Your peers are: ${workerIds.filter(w => w !== id).join(", ")}.`,
						`Negotiate with them via IRC (use \`irc send to:worker:*\` for broadcast).`,
						`Work in the workspace: ${workspace}.`,
						planContent ? `\n## Plan\n\n${planContent}` : "",
						feedbackBlock,
						roleSuggestions?.[id]
							? `\n## Role\n\nCloner review suggests your role for this round: **${roleSuggestions[id]}**.\nThis is non-binding — coordinate with peers to confirm your approach.\n`
							: "",
						extraContext ?? "",
						`\nProduce your output in the workspace directory.`,
					].join("\n"),
					index: i,
					id: `worker-${id}`,
					modelRegistry,
					settings,
					signal,
				}),
			),
		);

		return results.map((r, i) => {
			if (r.status === "fulfilled") return r.value;
			const errMsg = r.reason instanceof Error ? r.reason.message : String(r.reason);
			errors.push(`Worker ${workerIds[i]} crashed: ${errMsg}`);
			return {
				index: i,
				id: `worker-${workerIds[i]}`,
				agent: workerIds[i],
				agentSource: "project" as const,
				task: "",
				exitCode: 1,
				output: `[CRASHED] ${errMsg}`,
				stderr: "",
				truncated: false,
				durationMs: 0,
				tokens: 0,
				requests: 0,
			};
		});
	}
	// -------------------------------------------------------------------
	// Run cloner review via ClonerCouncil
	// -------------------------------------------------------------------
	async #runClonerReview(
		clonerIds: string[],
		iteration: number,
		workerOutput: string,
		workspace: string,
		planContent: string | undefined,
		previousFindings: string[],
		modelRegistry?: ModelRegistry,
		settings?: Settings,
		signal?: AbortSignal,
	): Promise<ReviewVerdict> {
		const council = new ClonerCouncil(this.#channel!);
		return council.review(
			{
				clonerIds,
				workspace,
				iteration,
				workerOutput,
				planContent,
				previousFindings,
				deliberation: this.#loopConfig.enableDeliberation,
			},
			modelRegistry,
			settings,
			signal,
		);
	}
}

// ============================================================================
// Factory — wires LoopController with core runtime dependencies
// ============================================================================

export interface CreateLoopOptions {
	loopConfig: LoopSwarmConfig;
	workspace: string;
}

export function createLoopController(stateTracker: StateTracker, options: CreateLoopOptions): LoopController {
	const ircBus = IrcBus.global();
	const clonerAgentId = MAIN_AGENT_ID;

	return new LoopController({
		loopConfig: options.loopConfig,
		workspace: options.workspace,
		ircBus,
		clonerAgentId,
		stateTracker,
	});
}
