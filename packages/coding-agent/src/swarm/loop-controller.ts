import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { AgentLoopConfig } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";  // kept for gradual migration
import { SubprocessAgentExecutor, type AgentExecutor, type SwarmExecutorOptions } from "./executor";
import { logger } from "@oh-my-pi/pi-utils";
import { type FileRoundSummary, FileTracker } from "./file-tracker";
import type { PipelineOptions } from "./pipeline";
import { invokeHook, type PipelineHooks, type PipelineContext } from "./pipeline";
import { RegionLockManager } from "./region-lock";
import type { ActivityLogger } from "./activity-logger";
import { ClonerCouncil, type ReviewVerdict } from "./roundtable";
import type { AgentToolRestriction, LoopSwarmConfig } from "./schema";
import type { StateTracker } from "./state";
import { TaskComplexityAnalyzer } from "./task-analyzer";
import { TodoTracker } from "./todo-tracker";
import { type Nomination, WorkerChannel } from "./worker-channel";
import { type VerificationResult, VerificationHook } from "./verification-hook";

// ============================================================================
// Types
// ============================================================================

/**
 * Resolve tool restrictions for a given agent role from the loop config.
 * Checks the specific name first, then falls back to the wildcard "*".
 * Returns undefined when no restrictions are configured.
 */
function resolveToolRestrictions(
	loopConfig: LoopSwarmConfig,
	agentName: string,
): AgentToolRestriction | undefined {
	const restrictions = loopConfig.agentRestrictions;
	if (!restrictions) return undefined;
	return restrictions[agentName] ?? restrictions["*"] ?? undefined;
}

/**
 * Apply tool restrictions to an agent definition, mutating the tools/blockedTools fields.
 * If a restriction has `allowed`, it sets the whitelist. If it has `blocked`, it sets the blacklist.
 */
function applyToolRestrictions(
	agent: AgentDefinition,
	restriction: AgentToolRestriction | undefined,
): void {
	if (!restriction) return;
	if (restriction.allowed && restriction.allowed.length > 0) {
		agent.tools = restriction.allowed;
	}
	if (restriction.blocked && restriction.blocked.length > 0) {
		agent.blockedTools = restriction.blocked;
	}
}

export interface LoopOptions extends PipelineOptions {
	loopConfig: LoopSwarmConfig;
	ircBus?: IrcBus;
	clonerAgentId?: string;
	/** plan.md content from the Before Loop phase. Injected into worker + cloner prompts. */
	planContent?: string;
	/** Tracks agent status for TUI progress widget. */
	stateTracker: StateTracker;
	/** Optional activity logger for GUI/monitor integration. */
	activityLogger?: ActivityLogger;
	/** P0-F: Pipeline lifecycle hooks. */
	hooks?: PipelineHooks;
}

/** Structured round summary produced by the elected reviewer. */
export interface RoundSummaryData {
	round: number;
	reviewer: string;
	accomplished: Record<string, string>;
	issues: Array<{
		severity: "blocker" | "major" | "minor";
		workers: string[];
		file?: string;
		description: string;
		resolution?: string;
	}>;
	remaining: string[];
	recommended_division: Record<string, string>;
	convergence_opinion: "converging" | "diverging" | "stalled";
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
	/** Results of post-loop verification commands (if configured). */
	verificationResults?: VerificationResult;
}

/** Context payload broadcast when the loop is blocked awaiting user decision. */
export interface BlockerContext {
	iteration: number;
	lastFindings: string[];
	lastWorkerOutput: string;
	stagnationCount: number;
	workerCrashCounts: Record<string, number>;
	reason: string;
}

/** User resolution to a blockage. */
export type BlockerResolution = "continue" | "skip" | "abort";

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

FILE EDITING PROTOCOL (critical):
- The system enforces region-level locking on files. When you use edit, write, or bash
  to modify a file, the system automatically acquires a lock and broadcasts your intent.
- If another worker is already editing a file you target, your tool call is BLOCKED
  with a message naming the holding worker. You MUST negotiate via IRC:
  1. Send an IRC message to the holding worker: "I need to edit <file>. Can you release it?"
  2. Wait for their reply. They may finish and release, or you may agree to edit
     different sections.
  3. Retry your edit after the lock is released.
- When you are blocked, DO NOT repeatedly retry — negotiate first.
- After your edit completes, the lock is released automatically.

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
- Always produce verifiable output in the workspace.

SELF-VERIFICATION (P0-5 — critical):
- After making changes, RUN THE TESTS before declaring your work complete.
- Use \`bash\` to run: \`bun test\`, \`cargo test\`, \`pytest\`, or the project's test runner.
- If tests fail, fix the issues BEFORE moving on. Do not leave broken tests.
- If a test was already failing before your changes, note it in your Round Summary.
- In your ## Round Summary, report:
  - Which tests you ran (command line)
  - Whether they passed (N passed, M failed)
  - Any failures and how you resolved them, or if pre-existing

GAP DETECTION (P0-E -- critical, NOT optional):
- After completing your work, you MUST identify what is MISSING or incomplete.
- This is a REQUIRED field -- you cannot write "N/A" or leave it blank.
- Think beyond your assigned role: what does the project need that was not in the plan?
- Examples: missing error handling, missing input validation, missing rate limiting,
  missing tests, missing documentation, missing edge case coverage.
- If you genuinely found NO gaps, explain WHY (e.g. "All plan requirements met with tests").
- Finding real gaps is VALUED -- it improves the swarm output quality.


OUTPUT FORMAT (critical):
At the end of every round's output, you MUST include a **## Round Summary** section.
This is the ONLY part of your output that other workers will read in the next round.
Make it self-contained — a peer who reads only this summary must understand:
- What files you created or modified (with exact paths)
- What tests you ran and their results (P0-5: e.g. "bun test auth/: 12 passed, 0 failed")
- What decisions you made and why
- What's incomplete and needs follow-up
- Any conflicts or quality concerns you noticed about other workers' work

Keep it concise (200-500 words). Do not paste code — reference files instead.
Example:

## Round Summary
- Created src/auth/login.ts: JWT-based login with bcrypt password verification
- Modified src/db/schema.ts: added users and sessions tables
- Decision: used RS256 instead of HS256 for JWT (asymmetric, better for distributed verification)
- Incomplete: password reset flow not yet implemented
- Concern: worker-2's auth middleware duplicates token validation logic from login.ts — coordinate to deduplicate
- **MISSING**: rate limiting on auth endpoints — brute force risk. Should be added to security review checklist.
- Next: implement token refresh endpoint, then integration tests`;

const DELIBERATION_SYSTEM_PROMPT = `\
You are a Worker in the DELIBERATION phase of the Loop Engineering system.
The work round has produced outputs — now you debate them to find and fix issues.

DELIBERATION PROTOCOL:
This phase has up to 3 sub-rounds. In each sub-round you will receive your peers' outputs.

Sub-round 1 — CHALLENGE:
- Read EVERY peer's output carefully.
- Identify gaps, contradictions, quality issues, or deviations from the plan.
- For each issue found, send an IRC message to the relevant worker (use irc send):
  Format: "CHALLENGE: <specific issue with file/line reference>"
- Be direct — politeness hides bugs.

Sub-round 2 — REBUTTAL:
- Read challenges directed at you.
- For each valid challenge: acknowledge, fix your output, and reply via IRC:
  Format: "REBUTTAL: <how you addressed the issue>"
- For challenges you disagree with: explain why via IRC:
  Format: "DISAGREE: <reason with evidence>"
- Update your work files accordingly.

Sub-round 3 — RESOLUTION:
- Review all rebuttals and disagreements.
- For unresolved disagreements: the elected Reviewer issues a RULING via IRC:
  Format: "RULING: <decision with rationale>"
- If no Reviewer is elected, workers vote via IRC: "VOTE: worker-N on issue X"
- After rulings, refine your output one final time.

TOOLS:
- During deliberation you may READ files and SEND IRC messages.
- You may NOT edit, write, or execute bash — this is review-only.
- The system will block any write/edit/bash attempts.

OUTPUT:
- End your deliberation turn with a brief summary of what you challenged, what you fixed,
  and any unresolved disagreements that need escalation.
`;

// Similarity & Summary Utilities
// ============================================================================

/** Extract the `## Round Summary` section from a worker's output.
 * Falls back to the first 2000 chars when no summary section is found. */
function extractRoundSummary(output: string): string {
	const match = output.match(/## Round Summary\n([\s\S]*?)(?=\n## |\n```|\n---\n|---|\n\*\*\*|\n___|$)/);
	return match?.[1]?.trim() || output.slice(0, 2000);
}

/**
 * Parse a `## Nomination` section from a worker's output.
 * Format expected:
 *   ## Nomination
 *   nominated: worker-3
 *   reason: has auth expertise
 */
function parseNomination(output: string): Nomination | null {
	const section = output.match(/## Nomination\n([\s\S]*?)(?=\n## |\n```|\n---\n|---|\n\*\*\*|\n___|$)/);
	if (!section?.[1]) return null;
	const nominated = section[1].match(/nominated:\s*(\S+)/);
	if (!nominated?.[1]) return null;
	return { nominator: "", nominee: nominated[1] };
}
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

/**
 * Parse the reviewer's Round Summary JSON from a worker's output.
 * Looks for a JSON code block after `## Round Summary`.
 * Returns null if no valid JSON round summary is found.
 */
function parseRoundSummaryJson(output: string): RoundSummaryData | null {
	const jsonBlock = output.match(/```json\n([\s\S]*?)\n```/);
	if (!jsonBlock?.[1]) return null;
	try {
		const parsed = JSON.parse(jsonBlock[1]) as RoundSummaryData;
		if (typeof parsed.round !== "number" || typeof parsed.convergence_opinion !== "string") return null;
		return parsed;
	} catch {
		return null;
	}
}

// ============================================================================
// Controller
export class LoopController {
	readonly #loopConfig: LoopSwarmConfig;
	readonly #ircBus: IrcBus;
	readonly #clonerId: string;
	readonly #stateTracker: StateTracker;
	#channel?: WorkerChannel;
	#fileTracker: FileTracker = new FileTracker();
	readonly #activityLogger?: ActivityLogger;
	#verificationHook: VerificationHook | null = null;
	// P0-1: Injectable agent executor. Defaults to SubprocessAgentExecutor.
	// Future: replace runSubprocess calls with this.#executor.execute() once the
	// SwarmExecutorOptions interface supports all AgentDefinition fields (hooks, etc.).
	readonly #executor: AgentExecutor;

	// ── Pause / Resume / Replan support ────────────────────────────────────
	/** Set by pause(); when non-null the loop is paused and awaiting resume. */
	#pauseSignal: AbortController | null = null;
	/** Resolver for the pause promise — called by resume() to unblock the loop. */
	#pauseResolver: (() => void) | null = null;
	/** Mutable plan content — updated by updatePlan() for subsequent iterations. */
	#planContent: string | undefined;

	// ── Todo tracking ──────────────────────────────────────────────────────
	#todoTracker: TodoTracker = new TodoTracker();

	// ── Blockage detection state ──
	/** Consecutive cloner-review stagnation count (findings identical across iterations). */
	#stagnationCount = 0;
	/** Last cloner findings key for stagnation comparison. */
	#lastFindingsKey = "";
	/** Per-worker crash counter — used to detect repeated worker failures. */
	#workerCrashCounts: Record<string, number> = {};
	/** Pending blocker resolution Promise resolver — set when blocked, cleared on resolve. */
	#blockerResolver: ((decision: BlockerResolution) => void) | null = null;
	/** Context for the current blockage (if any). */
	#currentBlockerContext: BlockerContext | null = null;

	constructor(options: LoopOptions) {
		this.#loopConfig = options.loopConfig;
		this.#ircBus = options.ircBus ?? IrcBus.global();
		this.#clonerId = options.clonerAgentId ?? MAIN_AGENT_ID;
		this.#stateTracker = options.stateTracker;
		this.#activityLogger = options.activityLogger;
		// P0-1: Use injected executor or default to SubprocessAgentExecutor.
		this.#executor = options.executor ?? new SubprocessAgentExecutor();
		// Instantiate verification hook when verification commands are configured.
		if (this.#loopConfig.verification?.commands?.length) {
			this.#verificationHook = new VerificationHook(options.workspace, this.#activityLogger);
		}
	}

	// ── Pause / Resume / Replan API ────────────────────────────────────────

	/**
	 * Pause the loop. The next iteration boundary will block until resume() is called.
	 * If the loop is already paused or not running, this is a no-op.
	 */
	pause(): void {
		if (this.#pauseSignal) return; // already paused
		this.#pauseSignal = new AbortController();
		void this.#stateTracker.updatePipeline({ loopPhase: "paused" });
		this.#activityLogger?.logPhase("paused");
		this.#activityLogger?.logBroadcast(this.#clonerId, "Loop paused. Awaiting plan update or resume.");
		logger.info("LoopController paused");
	}

	/**
	 * Resume the loop after a pause. Resolves the pause promise so the
	 * blocked iteration can proceed.
	 */
	resume(): void {
		if (!this.#pauseSignal) return; // not paused
		void this.#stateTracker.updatePipeline({ loopPhase: "running" });
		this.#activityLogger?.logPhase("running");
		this.#activityLogger?.logBroadcast(this.#clonerId, "Loop resumed.");
		const resolver = this.#pauseResolver;
		this.#pauseSignal = null;
		this.#pauseResolver = null;
		resolver?.();
		logger.info("LoopController resumed");
	}

	/**
	 * Update the plan content per-session. Writes the new plan to
	 * {swarmDir}/.omp/plan.md and updates in-memory planContent.
	 * Should be called while the loop is paused.
	 */
	async updatePlan(newPlanContent: string, swarmDir: string): Promise<void> {
		this.#planContent = newPlanContent;
		const planPath = path.join(swarmDir, ".omp", "plan.md");
		try {
			await fs.mkdir(path.dirname(planPath), { recursive: true });
			await fs.writeFile(planPath, newPlanContent, "utf-8");
		} catch (err) {
			logger.warn("Failed to write updated plan.md", { error: String(err) });
		}
		this.#activityLogger?.logBroadcast(this.#clonerId, "Plan updated. New plan will be used in the next iteration.");
		logger.info("LoopController plan updated", { length: newPlanContent.length });
	}

	/**
	 * If the loop is currently paused, block until resume() is called.
	 * Called at the start of each iteration boundary.
	 */
	async #checkPause(): Promise<void> {
		if (!this.#pauseSignal) return;
		await new Promise<void>((resolve) => {
			this.#pauseResolver = resolve;
		});
	}

	async runLoop(options: PipelineOptions & { planContent?: string }): Promise<LoopResult> {
		const verdicts: ReviewVerdict[] = [];
		const errors: string[] = [];
		const clonerFeedbackHistory: string[] = [];
		// Convergence tracking — uses instance fields (#stagnationCount, #lastFindingsKey)
		const convergenceThreshold = this.#loopConfig.convergenceThreshold;
		// Reset blockage state at the start of a fresh loop
		this.#stagnationCount = 0;
		this.#lastFindingsKey = "";
		this.#workerCrashCounts = {};
		// Dynamic worker tracking
		// Per-iteration role suggestions from cloner review (Round 2+).
		let currentRoleSuggestions: Record<string, string> = {};
		let currentWorkerCount = this.#loopConfig.workers.initial;
		let currentMaxRounds = this.#loopConfig.workers.maxRounds;
		let currentConvergenceNeeded = this.#loopConfig.workers.roundsConvergenceThreshold;

		const workerIds: string[] = [];
		let clonerIds: string[] = [];
		const { workspace, modelRegistry, settings, signal } = options;

	// P0-F: Pipeline hooks.
	const hooks = options.hooks;
	const pipelineCtx: PipelineContext = { waves: [], totalTokens: 0, totalRequests: 0 };
	await invokeHook(hooks, "beforePipeline", () => hooks?.beforePipeline?.(pipelineCtx));
		// Store plan content in the mutable instance field so updatePlan() can
		// replace it for subsequent iterations.
		this.#planContent = options.planContent;

		// TaskComplexityAnalyzer: override worker count, maxRounds, and convergence
		// based on plan.md content when workers.auto is enabled.
		if (this.#loopConfig.workers.auto && this.#planContent) {
			const analyzer = new TaskComplexityAnalyzer();
			const rec = await analyzer.analyze(this.#planContent, this.#loopConfig);
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

		// Parse plan.md into structured todo items for real-time tracking
		if (this.#planContent) {
			const todos = this.#todoTracker.parsePlan(this.#planContent);
			if (todos.length > 0) {
				await this.#stateTracker.updatePipeline({ todos });
				this.#activityLogger?.logPhase("todo-updated");
			}
		}

		const initialWorkerCount = currentWorkerCount;
		const clonerCount = this.#loopConfig.cloners.count;

		// Initialize worker and cloner IDs
		for (let i = 0; i < initialWorkerCount; i++) workerIds.push(`worker-${i + 1}`);
		clonerIds = Array.from({ length: clonerCount }, (_, i) => `cloner-${i + 1}`);

		// Register initial workers and cloners to StateTracker so that
		// subsequent updateAgent / incrementPraise / etc. calls don't
		// silently no-op (state.ts:127 `if (!agent) return`).
		for (const id of workerIds) {
			await this.#stateTracker.registerAgent(id);
		}
		for (const id of clonerIds) {
			await this.#stateTracker.registerAgent(id);
		}

		this.#channel = new WorkerChannel(this.#ircBus, {
			workers: workerIds,
			cloners: clonerIds,
		}, this.#activityLogger);
		// Create per-session RegionLockManager for file-level lock coordination.
		const lockMgr = new RegionLockManager();
		await this.#channel.broadcast(
			this.#clonerId,
			`Plan broadcast. Workers: ${initialWorkerCount}, Cloners: ${clonerCount}.`,
		);

		for (let iter = 0; iter < this.#loopConfig.maxIterations; iter++) {
			// Pause/resume gate: if pause() was called, block here until resume().
			// This allows the operator to update the plan between iterations.
			await this.#checkPause();

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
		this.#activityLogger?.logPhase("workers", undefined, iter + 1);
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
				let lastConflictReport: FileRoundSummary | null = null;
				let reviewerId: string | undefined;
				let nominationPrompt: string | undefined;
				for (let round = 0; round < hardLimit; round++) {
					if (iterSignal?.aborted) break;

					// Start nomination for this round
					this.#channel?.startNomination(round);
					nominationPrompt = this.#channel?.buildNominationPrompt();

					// Snapshot workspace before this round's workers execute
					await this.#fileTracker.startRound(workspace);

					// Build roundtable context — inject prior outputs AND file conflict reports for rounds > 0
					let extraContext = "";
					if (round > 0 && lastConflictReport) {
						const conflictText = FileTracker.formatConflictReport(lastConflictReport);
						if (conflictText) {
							extraContext = `${conflictText}\n\n`;
						}
					}
					if (round > 0) {
						const prompt = this.#loopConfig.workers.roundtablePrompt
							? `\n${this.#loopConfig.workers.roundtablePrompt}\n`
							: `\n## Prior Round Outputs\n\nCross-examine these outputs. Flag gaps, contradictions, and quality issues. Be direct — your peers expect honest critique. Refine and improve upon the prior work.\n`;
						extraContext = `${extraContext}${prompt}\n${priorOutputs}`;
					}

				let roundResults = await this.#spawnWorkers(
					workerIds,
					workspace,
					this.#planContent,
					clonerFeedbackHistory,
						modelRegistry,
						settings,
						iterSignal,
						errors,
						extraContext,
						currentRoleSuggestions,
						lockMgr,
						this.#channel,
						reviewerId,
						nominationPrompt,
					);

					if (iterSignal?.aborted) {
						return {
							status: "aborted",
							iterations: iter + 1,
							reviewVerdicts: verdicts,
							errors,
						};
					}

					// Release all locks held by round workers (defensive cleanup).
					for (const id of workerIds) lockMgr.releaseAll(id);
					allWorkerResults.push(...roundResults);

					// Deliberation phase: structured debate when enabled and round > 0
					const debateConfig = this.#loopConfig.debate ?? { enabled: true, maxRounds: 2 };
					if (debateConfig.enabled && round > 0 && debateConfig.maxRounds > 0) {
						await this.#stateTracker.updatePipeline({ roundtablePhase: "Debate: challenging" });
					roundResults = await this.#runDeliberationPhase(
						roundResults,
						workerIds,
						workspace,
						this.#planContent,
						modelRegistry,
							settings,
							iterSignal,
							errors,
							debateConfig.maxRounds,
						);
					}
				// Build prior outputs for next round — filter out crashed workers
				// so error messages don't pollute the next round's context.
				priorOutputs = roundResults
					.filter(r => !r.output.startsWith("[CRASHED]"))
					.map(r => `[${r.agent}]\n${extractRoundSummary(r.output)}`)
					.join("\n\n---\n\n");

					// Convergence detection: Round 1+ uses Reviewer's RoundSummary JSON;
					// Round 0 falls back to Jaccard text similarity.
					if (round > 0 && convergenceNeeded > 0) {
						let converged = false;
						// Try reviewer's structured summary first
						if (reviewerId) {
							const reviewerResult = roundResults.find(r => r.agent === reviewerId);
							if (reviewerResult) {
								const summary = parseRoundSummaryJson(reviewerResult.output);
								if (summary) {
									const hasBlocker = summary.issues.some(i => i.severity === "blocker");
									if (summary.convergence_opinion === "converging" && !hasBlocker) {
										convergenceStreak++;
										if (convergenceStreak >= convergenceNeeded) converged = true;
									} else {
										convergenceStreak = 0;
									}
								}
							}
						}
						// Fallback: Jaccard text similarity when no reviewer summary is available
						if (!reviewerId || convergenceStreak === 0) {
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
								if (convergenceStreak >= convergenceNeeded) converged = true;
							} else {
								convergenceStreak = 0;
							}
						}
						if (converged) {
							workersConverged = true;
							break;
						}
					}

					// Parse nominations from worker outputs and elect reviewer for next round
					for (const result of roundResults) {
						const nom = parseNomination(result.output);
						if (nom) {
							this.#channel?.processNomination(result.agent, nom.nominee);
						}
					}
					const nominationResult = this.#channel?.tally();
					reviewerId = nominationResult?.elected ?? undefined;

					// Update state tracker: mark reviewer role, clear previous
					for (const id of workerIds) {
						await this.#stateTracker.updateAgent(id, {
							role: id === reviewerId ? "reviewer" : undefined,
						});
					}
				}

				// All worker rounds complete — mark workers as completed in
				// StateTracker so the widget reflects their finished state.
				for (const id of workerIds) {
					await this.#stateTracker.updateAgent(id, {
						status: "completed",
						iteration: iter,
						completedAt: Date.now(),
					});
				}

				// File conflict detection: collect raw worker outputs for attribution
				const workerOutputMap = new Map<string, string>();
				for (const r of allWorkerResults) {
					workerOutputMap.set(r.agent, r.output);
				}
				lastConflictReport = await this.#fileTracker.endRound(workerOutputMap);

				// Wire stateTracker conflict count for overlap conflicts
				const overlapConflicts = lastConflictReport.conflicts.filter(c => c.severity === "overlap");
				for (const c of overlapConflicts) {
					this.#activityLogger?.logConflict(c.file, c.writers, c.severity);
					for (const writerId of c.writers) {
						await this.#stateTracker.incrementConflict(writerId);
					}
				}

				// Emit tool_call events for AgentTimeline visualization
				for (const r of allWorkerResults) {
					this.#activityLogger?.logToolCall(
						r.agent,
						"round_complete",
						undefined,
						r.output.slice(0, 200),
						r.exitCode !== 0 ? `exit ${r.exitCode}` : undefined,
						r.durationMs ?? undefined,
					);
				}

				// Emit file_change events for FileChangesPanel
				for (const f of lastConflictReport.changedFiles) {
					const writers = lastConflictReport.conflicts
						.filter(c => c.file === f)
						.flatMap(c => c.writers);
					this.#activityLogger?.logFileChange(
						writers[0] ?? "unknown",
						f,
						"modified",
					);
				}

			// 3. Collect worker output for review context (all rounds)
			lastWorkerOutput = allWorkerResults.map(r => `[${r.agent}] ${r.output.slice(0, 4000)}`).join("\n\n---\n\n");

			// Update todo statuses from worker round summaries
			if (this.#planContent && this.#stateTracker.state.todos && this.#stateTracker.state.todos.length > 0) {
				const updatedTodos = this.#todoTracker.updateFromWorkerOutput(
					lastWorkerOutput,
					this.#stateTracker.state.todos,
				);
				await this.#stateTracker.updatePipeline({ todos: updatedTodos });
				this.#activityLogger?.logPhase("todo-updated");
			}

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
				// ── Verification hook ──
				if (this.#verificationHook && this.#loopConfig.verification) {
					const vResult = await this.#verificationHook.run(this.#loopConfig.verification.commands);
					if (!vResult.passed && this.#loopConfig.verification.blocking) {
						// Blocking failure → continue to next iteration instead of completing
						errors.push(`Verification failed (blocking) at iteration ${iter + 1}`);
						continue;
					}
					return {
						status: "completed",
						iterations: iter + 1,
						reviewVerdicts: verdicts,
						errors,
						verificationResults: vResult,
					};
				}
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
			this.#activityLogger?.logPhase("cloner-review", undefined, iter + 1);
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
				this.#planContent,
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
			this.#activityLogger?.logVerdict(verdict);
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
				// ── Verification hook ──
				if (this.#verificationHook && this.#loopConfig.verification) {
					const vResult = await this.#verificationHook.run(this.#loopConfig.verification.commands);
					if (!vResult.passed && this.#loopConfig.verification.blocking) {
						// Blocking failure → continue to next iteration instead of completing
						errors.push(`Verification failed (blocking) at iteration ${iter + 1}`);
						continue;
					}
					return {
						status: "completed",
						iterations: iter + 1,
						reviewVerdicts: verdicts,
						errors,
						verificationResults: vResult,
					};
				}
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
		// Uses instance fields #stagnationCount and #lastFindingsKey (shared with #detectBlockage).
		if (convergenceThreshold > 0) {
			const prevFindings = this.#lastFindingsKey ? this.#lastFindingsKey.split("||") : [];
			const currFindings = verdict.findings;
			const similarity = prevFindings.length > 0 ? findingsSimilarity(prevFindings, currFindings) : 0;

			if (similarity >= 0.8) {
				this.#stagnationCount++;
				if (this.#stagnationCount >= convergenceThreshold) {
					// Exact match → full convergence failure
					if (similarity >= 1.0 || (similarity >= 0.95 && this.#stagnationCount >= convergenceThreshold + 1)) {
						const result: LoopResult = {
							status: "converged_failed",
							iterations: iter + 1,
							reviewVerdicts: verdicts,
							errors: [
								...errors,
								`Converged after ${this.#stagnationCount} near-identical review rounds (similarity: ${similarity.toFixed(2)})`,
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
							`Partially converged after ${this.#stagnationCount} rounds (Jaccard: ${similarity.toFixed(2)})`,
						],
					};
				}
			} else {
				this.#stagnationCount = 0;
			}
			this.#lastFindingsKey = currFindings.sort().join("||");
		}

		// ── Blockage detection: stagnation or worker deadlock ──
		// Called after convergence check. If the loop is stuck, the loop pauses
		// here awaiting user resolution (continue / skip / abort).
		{
			const resolution = await this.#detectBlockage(iter, verdict, lastWorkerOutput);
			if (resolution === "abort") {
				return {
					status: "aborted",
					iterations: iter + 1,
					reviewVerdicts: verdicts,
					errors: [...errors, "Loop aborted by user via blocker resolution"],
				};
			}
			if (resolution === "skip") {
				// Skip remaining processing for this iteration
				continue;
			}
			// "continue" → reset happened in resolveBlocker(), proceed normally
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
					this.#activityLogger?.logScaling("add", newId, `cloner suggestion +${delta}`);
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
					await this.#stateTracker.unregisterAgent(removed);
					this.#activityLogger?.logScaling("remove", removed, `cloner suggestion ${delta}`);
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

	// ── Verification hook (bottom fallthrough: all iterations exhausted) ──

	// P0-F: afterPipeline hook.
	const finalStatus = verdicts.length > 0 ? "completed" : "failed";
	await invokeHook(hooks, "afterPipeline", () => hooks?.afterPipeline?.(finalStatus, pipelineCtx));

	// At this point the loop ran all iterations without an explicit completion.
	// Run verification if configured; a blocking failure can't continue (no more
	// iterations), so we just record the result and return "completed" or "failed".
	if (this.#verificationHook && this.#loopConfig.verification) {
		const vResult = await this.#verificationHook.run(this.#loopConfig.verification.commands);
		const status: LoopResult["status"] = (!vResult.passed && this.#loopConfig.verification.blocking)
			? "failed"
			: "completed";
		return {
			status,
			iterations: this.#loopConfig.maxIterations,
			reviewVerdicts: verdicts,
			errors,
			verificationResults: vResult,
		};
	}
	return {
		status: "completed",
		iterations: this.#loopConfig.maxIterations,
		reviewVerdicts: verdicts,
		errors,
	};
	}

	// -------------------------------------------------------------------
	// Blockage detection
	// -------------------------------------------------------------------

	/**
	 * Detect whether the loop is blocked after a cloner review.
	 *
	 * Conditions that trigger a blockage:
	 * 1. Cloner findings have stagnated (stagnationCount >= 3, already tracked
	 *    by the convergence detection block above).
	 * 2. The same worker crashes 3+ times across iterations (deadlock).
	 *
	 * When a blockage is detected:
	 * - Sets loopPhase to "blocked" via stateTracker.
	 * - Broadcasts blocker context via ActivityLogger → SSE.
	 * - Awaits user resolution via a Promise (continue / skip / abort).
	 *
	 * Note: stagnation counters (#stagnationCount, #lastFindingsKey) are
	 * already updated by the convergence detection block. This method only
	 * checks thresholds and triggers the blockage pause.
	 *
	 * @returns The user's resolution decision.
	 */
	async #detectBlockage(
		iteration: number,
		verdict: ReviewVerdict,
		lastWorkerOutput: string,
	): Promise<BlockerResolution> {
		const STAGNATION_THRESHOLD = 3;
		const CRASH_THRESHOLD = 3;

		// Stagnation: already tracked by convergence detection
		const stagnated = this.#stagnationCount >= STAGNATION_THRESHOLD;

		// Worker crash deadlock: any single worker crashed CRASH_THRESHOLD+ times
		let deadlocked = false;
		for (const count of Object.values(this.#workerCrashCounts)) {
			if (count >= CRASH_THRESHOLD) {
				deadlocked = true;
				break;
			}
		}

		if (!stagnated && !deadlocked) {
			return "continue";
		}

		// Build blocker context
		const reason = stagnated
			? `Cloner findings have stagnated for ${this.#stagnationCount} consecutive iterations`
			: `Worker crash deadlock detected (a worker crashed ${CRASH_THRESHOLD}+ times)`;

		this.#currentBlockerContext = {
			iteration: iteration + 1,
			lastFindings: verdict.findings,
			lastWorkerOutput: lastWorkerOutput.slice(0, 8000),
			stagnationCount: this.#stagnationCount,
			workerCrashCounts: { ...this.#workerCrashCounts },
			reason,
		};

		// Set loop phase to blocked
		await this.#stateTracker.updatePipeline({ loopPhase: "blocked", roundtablePhase: `Blocked: ${reason}` });
		this.#activityLogger?.logPhase("blocked", undefined, iteration + 1);
		this.#activityLogger?.logBroadcast("system", JSON.stringify({
			type: "blocker",
			context: this.#currentBlockerContext,
		}));

		logger.warn(`Blockage detected at iteration ${iteration + 1}: ${reason}`);

		// Await user resolution with P2-4 timeout (5 min auto-degrade to continue).
		const BLOCKER_TIMEOUT_MS = 5 * 60 * 1000;
		const resolution = await new Promise<BlockerResolution>((resolve) => {
			this.#blockerResolver = resolve;
			// P2-4: Auto-continue after timeout to prevent indefinite blocking.
			setTimeout(() => {
				if (this.#blockerResolver === resolve) {
					logger.warn(`Blocker timed out after ${BLOCKER_TIMEOUT_MS}ms — auto-continuing`);
					this.#activityLogger?.logPhase("blocker-timeout", undefined, iteration + 1);
					resolve("continue");
				}
			}, BLOCKER_TIMEOUT_MS);
		});

		this.#blockerResolver = null;
		this.#currentBlockerContext = null;

		// Restore loop phase to running (unless aborting)
		if (resolution !== "abort") {
			await this.#stateTracker.updatePipeline({ loopPhase: "running" });
			this.#activityLogger?.logPhase("running", undefined, iteration + 1);
		}

		return resolution;
	}

	/**
	 * Resolve the current blockage — called externally (via API) to unblock the loop.
	 * - "continue": reset stagnation counters and proceed to the next iteration.
	 * - "skip": skip the current iteration's remaining processing.
	 * - "abort": stop the loop entirely.
	 */
	resolveBlocker(decision: BlockerResolution): boolean {
		if (!this.#blockerResolver) return false;

		if (decision === "continue") {
			this.#stagnationCount = 0;
			this.#lastFindingsKey = "";
			this.#workerCrashCounts = {};
		}

		this.#blockerResolver(decision);
		return true;
	}

	/** Track worker crashes for deadlock detection (called from #spawnWorkers error handler). */
	#trackWorkerCrash(workerId: string): void {
		this.#workerCrashCounts[workerId] = (this.#workerCrashCounts[workerId] ?? 0) + 1;
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
		lockMgr?: RegionLockManager,
		channel?: WorkerChannel,
		reviewerId?: string,
		nominationPrompt?: string,
	): Promise<SingleResult[]> {
		const feedbackBlock =
			previousFeedback.length > 0
				? `\n## Previous Review Feedback\n\n${previousFeedback.map((f, i) => `(Iteration ${i + 1}) ${f}`).join("\n")}\n`
				: "";

		// Build lock hooks shared across workers when lockMgr is active.
		const hooks = lockMgr && channel ? (id: string) => this.#buildLockHooks(id, lockMgr, channel) : undefined;

		const results = await Promise.allSettled(
			workerIds.map((id, i) => {
				const workerHooks = hooks?.(id);
				const isReviewer = reviewerId !== undefined && id === reviewerId;
				const systemPrompt = isReviewer
					? `${WORKER_SYSTEM_PROMPT}\n${WorkerChannel.buildReviewerPrompt()}`
					: WORKER_SYSTEM_PROMPT;

			const agentDef: AgentDefinition = {
				name: id,
				description: `Loop Engineering Worker ${i + 1}`,
				systemPrompt,
				source: "project" as const,
			};
			applyToolRestrictions(agentDef, resolveToolRestrictions(this.#loopConfig, "worker"));

			return runSubprocess({ cwd: workspace, agent: agentDef, task: [
						`You are Worker ${i + 1} of ${workerIds.length}.`,
						`Your peers are: ${workerIds.filter(w => w !== id).join(", ")}.`,
						`Negotiate with them via IRC (use \`irc send to:worker:*\` for broadcast).`,
						`Work in the workspace: ${workspace}.`,
						planContent ? `\n## Plan\n\n${planContent}` : "",
						feedbackBlock,
						roleSuggestions?.[id]
							? `\n## Role\n\nCloner review suggests your role for this round: **${roleSuggestions[id]}**.\nThis is non-binding — coordinate with peers to confirm your approach.\n`
							: "",
						nominationPrompt ?? "",
						extraContext ?? "",
					].join("\n"),
					index: i,
					id: `worker-${id}`,
					modelRegistry,
					settings,
					signal,
					beforeToolCall: workerHooks?.beforeToolCall,
					afterToolCall: workerHooks?.afterToolCall,
				}).then(
					result => result,
					(err) => {
						// Release locks immediately on crash so other still-running
						// workers are not blocked on stale file locks.
						if (lockMgr) lockMgr.releaseAll(id);
						throw err;
					},
				);
			}),
		);

		return results.map((r, i) => {
			if (r.status === "fulfilled") return r.value;
			const errMsg = r.reason instanceof Error ? r.reason.message : String(r.reason);
			errors.push(`Worker ${workerIds[i]} crashed: ${errMsg}`);
			this.#trackWorkerCrash(workerIds[i]);
			this.#activityLogger?.logCrash(workerIds[i], errMsg);
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
	// Build per-worker lock hooks for tier 1 (intent broadcast) + tier 2 (function-level lock)
	// -------------------------------------------------------------------
	#buildLockHooks(workerId: string, lockMgr: RegionLockManager, channel: WorkerChannel) {
		/** Tool names that modify files — intercepted for lock coordination. */
		const EDIT_TOOLS = new Set(["edit", "write", "bash"]);

		/** Extract the target file path from a tool call's args. */
		const extractPath = (name: string, args: Record<string, unknown>): string | null => {
			if (name === "write") {
				return typeof args.path === "string" ? args.path : null;
			}
			if (name === "edit") {
				const input = typeof args.input === "string" ? args.input : "";
				const m = /^\[([^\]#]+)(?:#[^\]]+)?\]/m.exec(input);
				return m?.[1] ?? null;
			}
			if (name === "bash") {
				const cmd = typeof args.command === "string" ? args.command : "";
				const m = />[>]?\s*(\S+)/.exec(cmd);
				return m?.[1] ?? null;
			}
			return null;
		};

		const beforeToolCall: AgentLoopConfig["beforeToolCall"] = ctx => {
			const name = ctx.toolCall.name;
			if (!EDIT_TOOLS.has(name)) return undefined;

			const file = extractPath(name, ctx.args);
			if (!file) return undefined;

			// Tier 2: check if another worker holds a lock on this file
			const check = lockMgr.checkLock(file, workerId);
			if (check.locked && check.entry) {
				void channel.broadcast(
					workerId,
					`[BLOCKED] ${workerId} wants ${file} but ${RegionLockManager.describeLock(check.entry)}.`,
				);
				return {
					block: true as const,
					reason: `File locked: ${RegionLockManager.describeLock(check.entry)}. Use IRC to negotiate.`,
				};
			}

			// Tier 2: acquire lock before tool executes
			if (!lockMgr.tryLock(workerId, file)) {
				return {
					block: true as const,
					reason: `Cannot acquire lock on ${file} — concurrent edit conflict. Retry or negotiate via IRC.`,
				};
			}

			// Tier 1: broadcast editing intent
			void channel.broadcast(workerId, `[EDITING] ${workerId} started editing ${file}.`);

			return undefined;
		};

		const afterToolCall: AgentLoopConfig["afterToolCall"] = ctx => {
			const name = ctx.toolCall.name;
			if (!EDIT_TOOLS.has(name)) return undefined;

			const file = extractPath(name, ctx.args);
			if (!file) return undefined;

			lockMgr.release(workerId, file);
			void channel.broadcast(workerId, `[DONE] ${workerId} finished editing ${file}.`);

			return undefined;
		};

		return { beforeToolCall, afterToolCall };
	}
	// -------------------------------------------------------------------
	// Deliberation — structured debate between workers within a round
	// -------------------------------------------------------------------
	/**
	 * Run a deliberation phase where workers challenge, rebut, and resolve
	 * each other's outputs. Workers spawn with read-only tool access.
	 * @returns refined outputs after deliberation, or original results on failure.
	 */
	async #runDeliberationPhase(
		roundResults: SingleResult[],
		workerIds: string[],
		workspace: string,
		planContent: string | undefined,
		modelRegistry: ModelRegistry | undefined,
		settings: Settings | undefined,
		signal: AbortSignal | undefined,
		errors: string[],
		maxSubRounds: number,
	): Promise<SingleResult[]> {
		if (maxSubRounds <= 0 || roundResults.length === 0) return roundResults;

		const EDIT_TOOLS = new Set(["edit", "write", "bash"]);
		const deliberationHooks: { beforeToolCall: AgentLoopConfig["beforeToolCall"] } = {
			beforeToolCall: ctx => {
				if (EDIT_TOOLS.has(ctx.toolCall.name)) {
					return {
						block: true as const,
						reason: "Deliberation phase: write/edit/bash blocked. Use IRC to debate.",
					};
				}
				return undefined;
			},
		};

		// Build context: each worker sees all peers' outputs
		const allOutputs = roundResults.map(r => `[${r.agent}]\n${r.output.slice(0, 4000)}`).join("\n\n---\n\n");

		let currentOutputs = roundResults;
		for (let sub = 0; sub < maxSubRounds; sub++) {
			if (signal?.aborted) break;

			const subLabel = ["Challenge", "Rebuttal", "Resolution"][sub] ?? `Sub-round ${sub + 1}`;
			await this.#stateTracker.updatePipeline({
				roundtablePhase: `Debate: ${subLabel} (${sub + 1}/${maxSubRounds})`,
			});

			const subResults = await Promise.allSettled(
				workerIds.map((id, i) =>
					runSubprocess({
						cwd: workspace,
						agent: (() => {
							const def: AgentDefinition = {
								name: id,
								description: `Deliberation Worker ${i + 1}`,
								systemPrompt: DELIBERATION_SYSTEM_PROMPT,
								source: "project" as const,
							};
							applyToolRestrictions(def, resolveToolRestrictions(this.#loopConfig, "worker"));
							return def;
						})(),
						task: [
							`## ${subLabel} Phase`,
							sub === 0
								? "Read ALL peer outputs below. For each issue found, send IRC CHALLENGE to the relevant worker."
								: sub === 1
									? "Read challenges directed at you. Acknowledge + fix, or explain why you disagree. Update your output."
									: "Review all rebuttals. The Reviewer (or majority vote) issues RULINGs for unresolved disputes. Finalize your output.",
							planContent ? `\n## Plan\n\n${planContent}` : "",
							`\n## Peer Outputs (Round)\n\n${allOutputs}`,
							`\n## Your Previous Output\n\n${currentOutputs.find(r => r.agent === id)?.output.slice(0, 3000) ?? "(no prior output)"}`,
						].join("\n"),
						index: i,
						id: `deliberation-${id}`,
						modelRegistry,
						settings,
						signal,
						beforeToolCall: deliberationHooks.beforeToolCall,
					}),
				),
			);

			currentOutputs = subResults.map((r, i) => {
				if (r.status === "fulfilled") return r.value;
				const errMsg = r.reason instanceof Error ? r.reason.message : String(r.reason);
				errors.push(`Deliberation worker ${workerIds[i]} crashed: ${errMsg}`);
				return (
					currentOutputs[i] ?? {
						index: i,
						id: `deliberation-${workerIds[i]}`,
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
					}
				);
			});
		}

		return currentOutputs;
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
		const council = new ClonerCouncil();
		return council.review(
			{
				clonerIds,
				workspace,
				iteration,
				workerOutput,
				planContent,
				previousFindings,
				deliberation: this.#loopConfig.enableDeliberation,
				toolRestriction: resolveToolRestrictions(this.#loopConfig, "cloner"),
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
	activityLogger?: ActivityLogger;
	/** P0-F: Pipeline lifecycle hooks. */
	hooks?: PipelineHooks;
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
		activityLogger: options.activityLogger,
	});
}
