import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentLoopConfig } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor"; // kept for gradual migration
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { logger } from "@oh-my-pi/pi-utils";
import type { ActivityLogger } from "./activity-logger";
import { streamAgentOutput } from "./streaming";
import { type AgentExecutor, SubprocessAgentExecutor, type SwarmExecutorOptions } from "./executor";
import { type FileRoundSummary, FileTracker } from "./file-tracker";
import type { PipelineOptions } from "./pipeline";
import { invokeHook, type LoopPipelineHooks, type PipelineContext } from "./pipeline";
import { RegionLockManager } from "./region-lock";
import type { ReviewVerdict } from "./pipeline";
import type { AgentToolRestriction, LoopSwarmConfig, SwarmAgent } from "./schema";
import type { Chapter, StateTracker } from "./state";
import { SwarmStateMachine, type PhaseContext } from "./swarm-state-machine";
import { computeScaleDelta } from "./agent-scaler";
import { evaluateBlockage } from "./blockage";
import {
	type RoundSummaryData,
	extractRoundSummary,
	findingsSimilarity,
	jaccardSimilarity,
	parseNomination,
	parseRoundSummaryJson,
} from "./convergence";
import { TaskComplexityAnalyzer } from "./task-analyzer";

// Re-export for backward compatibility with external importers.
export type { RoundSummaryData };
import { TodoTracker } from "./todo-tracker";
import { VerificationHook, type VerificationResult } from "./verification-hook";
import { type Nomination, AgentChannel } from "./agent-channel";

// ============================================================================
// Types
// ============================================================================

/**
 * Resolve tool restrictions for a given agent role from the loop config.
 * Checks the specific name first, then falls back to the wildcard "*".
 * Returns undefined when no restrictions are configured.
 */
function resolveToolRestrictions(loopConfig: LoopSwarmConfig, agentName: string): AgentToolRestriction | undefined {
	const restrictions = loopConfig.agentRestrictions;
	if (!restrictions) return undefined;
	return restrictions[agentName] ?? restrictions["*"] ?? undefined;
}

/**
 * Apply tool restrictions to an agent definition, mutating the tools/blockedTools fields.
 * If a restriction has `allowed`, it sets the whitelist. If it has `blocked`, it sets the blacklist.
 */
function applyToolRestrictions(agent: AgentDefinition, restriction: AgentToolRestriction | undefined): void {
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
	hooks?: LoopPipelineHooks;
	/**
	 * P7: Per-agent context provider callback.
	 * Called for each agent before execution. Return value is appended
	 * to the agent's task prompt. Return null/empty to skip injection.
	 */
	getAgentContext?: (agentId: string) => string | null;
}

// RoundSummaryData now lives in ./convergence; re-exported (below) for
// backward compatibility with any external importer.

export interface LoopResult {
	status: "completed" | "failed" | "aborted" | "escalated" | "converged_failed" | "converged_partial";
	iterations: number;
	reviewVerdicts: ReviewVerdict[];
	errors: string[];
	/** When status is "escalated", carries context for human decision. */
	escalationContext?: {
		lastAgentOutput: string;
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
	lastAgentOutput: string;
	stagnationCount: number;
	agentCrashCounts: Record<string, number>;
	reason: string;
	/** Auto-continue timeout in ms (0 = no auto-continue). */
	timeoutMs: number;
	/** Absolute epoch-ms deadline for auto-continue, for a client-side countdown. */
	deadline: number;
}

/** Auto-continue timeout for an unresolved blocker (P2-4). */
export const BLOCKER_TIMEOUT_MS = 5 * 60 * 1000;

/** User resolution to a blockage. */
export type BlockerResolution = "continue" | "skip" | "abort";

// ============================================================================
// Prompts
// ============================================================================
const AGENT_SYSTEM_PROMPT = `\
You are an Agent in the SatoPi system — part of a self-organizing swarm.
You collaborate with other agents to complete a task defined in a plan that will be provided.

MECHANISM:
- A plan.md containing the goal, constraints, and acceptance criteria is broadcast.
- You and other agents negotiate via group chat (AgentChannel) how to divide the work.
  No one assigns tasks to you — you self-organize through open discussion.
- You can broadcast to all agents, create sub-groups, and elect roles (reviewer, integrator, etc.).
- After each round, you receive prior rounds' outputs for cross-examination.
- The swarm runs multiple rounds per iteration — review peers' work, spot issues, refine together.
- Agents can declare convergence via IRC when the output stabilizes.

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
- This internal review is your primary quality mechanism. Reviewers are latent guardians
  who only intervene when the swarm cannot resolve its own disagreements.

YOUR CAPABILITIES:
- Full tool access: read, write, edit, bash, grep, glob, web_search, browser
- Communicate with other agents via irc (use \`irc send\` with to:"agent:*" for broadcast)
- Write output to the workspace directory

BEHAVIOR:
- Proactively negotiate — don't wait to be told what to do.
- If another agent is duplicating your work, coordinate with them.
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
- Finding real gaps is VALUED — it improves the swarm output quality.


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

// (Convergence & summary utilities moved to ./convergence — imported above.)

// ============================================================================
// Controller
export class LoopController {
	readonly #loopConfig: LoopSwarmConfig;
	readonly #ircBus: IrcBus;
	readonly #reviewerId: string;
	readonly #stateTracker: StateTracker;
	#channel?: AgentChannel;
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
	#agentCrashCounts: Record<string, number> = {};
	/** Pending blocker resolution Promise resolver — set when blocked, cleared on resolve. */
	#blockerResolver: ((decision: BlockerResolution) => void) | null = null;
	/** Context for the current blockage (if any). */
	#currentBlockerContext: BlockerContext | null = null;

	// ── Explicit phase state machine (arbiter, not driver) ──────────────────
	/**
	 * Single authority for Chapter. Every phase change routes through
	 * #setChapter → this machine, which validates the transition and, on
	 * onEnter, ATOMICALLY updates StateTracker + ActivityLogger. runLoop keeps
	 * its own await-based suspension (checkPause / blockerResolver); the machine
	 * only arbitrates and broadcasts the phase.
	 */
	readonly #sm: SwarmStateMachine;

	constructor(options: LoopOptions) {
		this.#loopConfig = options.loopConfig;
		this.#ircBus = options.ircBus ?? IrcBus.global();
		this.#reviewerId = options.clonerAgentId ?? MAIN_AGENT_ID;
		this.#stateTracker = options.stateTracker;
		this.#activityLogger = options.activityLogger;
		// P0-1: Use injected executor or default to SubprocessAgentExecutor.
		this.#executor = options.executor ?? new SubprocessAgentExecutor();
		// Instantiate verification hook when verification commands are configured.
		if (this.#loopConfig.verification?.commands?.length) {
			this.#verificationHook = new VerificationHook(options.workspace, this.#activityLogger);
		}
		// Seed the machine from the tracker's current phase (defaults to running
		// context — pause/resume/block operate within an already-running loop).
		this.#sm = new SwarmStateMachine(this.#stateTracker.state.phase ?? "stage", {
			onEnter: async (phase, ctx) => {
				// Atomic broadcast: persist state + emit SSE phase event together.
				const update: Partial<import("./state").SwarmState> = { phase: phase };
				if (ctx.reason && phase === "blocked") update.roundtablePhase = `Blocked: ${ctx.reason}`;
				await this.#stateTracker.updatePipeline(update);
				this.#activityLogger?.logPhase(phase, undefined, ctx.iteration);
			},
			onError: (from, to, reason) => {
				// Never crash on an illegal/failed transition — record for audit.
				this.#activityLogger?.logPhase("invalid-transition", undefined, undefined);
				logger.warn("Chapter transition rejected", { from, to, reason });
			},
		});
	}

	/**
	 * The sole entry point for changing phase. Routes through the state
	 * machine so the transition is validated + broadcast atomically. `force`
	 * bypasses the table for hard aborts/resets.
	 */
	async #setChapter(to: Chapter, ctx: PhaseContext = {}, force = false): Promise<void> {
		if (force) {
			await this.#sm.force(to, ctx);
		} else {
			await this.#sm.transition(to, ctx);
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
		void this.#setChapter("paused");
		this.#activityLogger?.logBroadcast(this.#reviewerId, "Loop paused. Awaiting plan update or resume.");
		logger.info("LoopController paused");
	}

	/**
	 * Resume the loop after a pause. Resolves the pause promise so the
	 * blocked iteration can proceed.
	 */
	resume(): void {
		if (!this.#pauseSignal) return; // not paused
		void this.#setChapter("stage");
		this.#activityLogger?.logBroadcast(this.#reviewerId, "Loop resumed.");
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
		this.#activityLogger?.logBroadcast(this.#reviewerId, "Plan updated. New plan will be used in the next iteration.");
		logger.info("LoopController plan updated", { length: newPlanContent.length });
	}

	/**
	 * If the loop is currently paused, block until resume() is called.
	 * Called at the start of each iteration boundary.
	 */
	async #checkPause(): Promise<void> {
		if (!this.#pauseSignal) return;
		await new Promise<void>(resolve => {
			this.#pauseResolver = resolve;
		});
	}

	async runLoop(
		options: Omit<PipelineOptions, "hooks"> & {
			hooks?: LoopPipelineHooks;
			planContent?: string;
			getAgentContext?: (agentId: string) => string | null;
		},
	): Promise<LoopResult> {
		const verdicts: ReviewVerdict[] = [];
		const errors: string[] = [];
		const clonerFeedbackHistory: string[] = [];
		// Convergence tracking — uses instance fields (#stagnationCount, #lastFindingsKey)
		const convergenceThreshold = this.#loopConfig.convergenceThreshold;
		// Reset blockage state at the start of a fresh loop
		this.#stagnationCount = 0;
		this.#lastFindingsKey = "";
		this.#agentCrashCounts = {};
		// Dynamic worker tracking
		// Per-iteration role suggestions from cloner review (Round 2+).
		let currentRoleSuggestions: Record<string, string> = {};
		let currentAgentCount = this.#loopConfig.agents.initial;
		let currentMaxRounds = this.#loopConfig.agents.maxRounds;
		let currentConvergenceNeeded = this.#loopConfig.agents.roundsConvergenceThreshold;

		const agentIds: string[] = [];
		let reviewerIds: string[] = [];
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
		if (this.#loopConfig.agents.auto && this.#planContent) {
			const analyzer = new TaskComplexityAnalyzer();
			const rec = await analyzer.analyze(this.#planContent, this.#loopConfig);
			currentAgentCount = rec.workers;
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

		const initialWorkerCount = currentAgentCount;
		const reviewerCount = this.#loopConfig.agents.initial;

		// Initialize worker and cloner IDs
		for (let i = 0; i < initialWorkerCount; i++) agentIds.push(`agent-${i + 1}`);
		reviewerIds = Array.from({ length: reviewerCount }, (_, i) => `agent-r${i + 1}`);

		// Register initial workers and cloners to StateTracker so that
		// subsequent updateAgent / incrementPraise / etc. calls don't
		// silently no-op (state.ts:127 `if (!agent) return`).
		for (const id of agentIds) {
			await this.#stateTracker.registerAgent(id, this.#loopConfig.model);
		}
		for (const id of reviewerIds) {
			await this.#stateTracker.registerAgent(id, this.#loopConfig.model);
		}

		this.#channel = new AgentChannel(
			this.#ircBus,
			{
				workers: agentIds,
				cloners: reviewerIds,
			},
			this.#activityLogger,
		);
		// Create per-session RegionLockManager for file-level lock coordination.
		const lockMgr = new RegionLockManager();
		await this.#channel.broadcast(
			this.#reviewerId,
			`Plan broadcast. Workers: ${initialWorkerCount}, Cloners: ${reviewerCount}.`,
		);

		for (let iter = 0; iter < this.#loopConfig.maxIterations; iter++) {
			// Pause/resume gate: if pause() was called, block here until resume().
			// This allows the human to update the plan between iterations.
			await this.#checkPause();

			// P0-F: beforeIteration hook — can skip.
			const shouldRunIter = await invokeHook(hooks, "beforeIteration", () =>
				hooks?.beforeIteration?.(iter, pipelineCtx),
			);
			if (shouldRunIter === false) continue;

			if (signal?.aborted) {
				return {
					status: "aborted",
					iterations: iter,
					reviewVerdicts: verdicts,
					errors,
				};
			}

			// Create git snapshot before this iteration (if enabled)
			const snapshotId = await this.#createSnapshot(workspace, iter);

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
			for (const id of agentIds) {
				await this.#stateTracker.updateAgent(id, { status: "running", iteration: iter });
			}
			await this.#stateTracker.updatePipeline({ loopIteration: iter + 1, roundtablePhase: "Agents working" });
			this.#activityLogger?.logPhase("workers", undefined, iter + 1);
			options.onProgress?.({
				iteration: iter,
				targetCount: this.#loopConfig.maxIterations,
				currentWave: 0,
				totalWaves: 1,
				agents: Object.fromEntries(agentIds.map(id => [id, { status: "running", iteration: iter }])),
			});

			let verdict: ReviewVerdict | null = null;
			let lastAgentOutput = "";
			let agentsConverged = false;
			try {
				const maxRounds = currentMaxRounds;
				const convergenceNeeded = currentConvergenceNeeded;
				// 0 = unlimited; safety cap at 10 rounds
				const hardLimit = maxRounds === 0 ? 10 : maxRounds;
				const allAgentResults: SingleResult[] = [];
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
						const prompt = this.#loopConfig.agents.roundtablePrompt
							? `\n${this.#loopConfig.agents.roundtablePrompt}\n`
							: `\n## Prior Round Outputs\n\nCross-examine these outputs. Flag gaps, contradictions, and quality issues. Be direct — your peers expect honest critique. Refine and improve upon the prior work.\n`;
						extraContext = `${extraContext}${prompt}\n${priorOutputs}`;
					}

					// P0-F: beforeWorkerRound hook — can skip.
				const shouldRunRound = await invokeHook(hooks, "beforeWorkerRound", () =>
					hooks?.beforeWorkerRound?.(round, agentIds, pipelineCtx),
				);
				if (shouldRunRound === false) continue;

				let roundResults = await this.#spawnWorkers(
						agentIds,
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
						iter,
						options.getAgentContext,
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
					for (const id of agentIds) lockMgr.releaseAll(id);
					allAgentResults.push(...roundResults);

					// P0-F: afterWorkerRound hook.
					await invokeHook(hooks, "afterWorkerRound", () =>
						hooks?.afterWorkerRound?.(round, roundResults, pipelineCtx),
					);

					// Deliberation phase: structured debate when enabled and round > 0
					const debateConfig = this.#loopConfig.debate ?? { enabled: true, maxRounds: 2 };
					if (debateConfig.enabled && round > 0 && debateConfig.maxRounds > 0) {
						await this.#stateTracker.updatePipeline({ roundtablePhase: "Debate: challenging" });

						// P0-F: beforeDeliberation hook.
						await invokeHook(hooks, "beforeDeliberation", () => hooks?.beforeDeliberation?.(round, pipelineCtx));

						roundResults = await this.#runDeliberationPhase(
							roundResults,
							agentIds,
							workspace,
							this.#planContent,
							modelRegistry,
							settings,
							iterSignal,
							errors,
							debateConfig.maxRounds,
						);

						// P0-F: afterDeliberation hook.
						await invokeHook(hooks, "afterDeliberation", () =>
							hooks?.afterDeliberation?.(round, roundResults, pipelineCtx),
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
							agentsConverged = true;
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
					for (const id of agentIds) {
						await this.#stateTracker.updateAgent(id, {
							role: id === reviewerId ? "reviewer" : undefined,
						});
					}
				}

				// All worker rounds complete — mark workers as completed in
				// StateTracker so the widget reflects their finished state.
				for (const id of agentIds) {
					await this.#stateTracker.updateAgent(id, {
						status: "completed",
						iteration: iter,
						completedAt: Date.now(),
					});
				}

				// File conflict detection: collect raw worker outputs for attribution
				const agentOutputMap = new Map<string, string>();
				for (const r of allAgentResults) {
					agentOutputMap.set(r.agent, r.output);
				}

				// Emit tool_call events BEFORE endRound — these power the
				// AgentTimeline component and must fire regardless of whether
				// git diff succeeds. endRound failures previously skipped these
				// events entirely, leaving Timeline blank.
				for (const r of allAgentResults) {
					this.#activityLogger?.logToolCall(
						r.agent,
						"round_complete",
						undefined,
						r.output.slice(0, 200),
						r.exitCode !== 0 ? `exit ${r.exitCode}` : undefined,
						r.durationMs ?? undefined,
					);
				}

				// endRound with its own error boundary so a git-diff failure
				// does NOT skip all downstream events (conflict, file_change,
				// todo-updated, cloner-review, verdict).
				try {
					lastConflictReport = await this.#fileTracker.endRound(agentOutputMap);
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					this.#activityLogger?.logPhase("file-track-error", undefined, iter + 1);
					this.#activityLogger?.logBroadcast(
						"system",
						`File tracker error (iteration ${iter + 1}): ${errMsg}`,
					);
					logger.warn("FileTracker endRound failed, using empty report", { error: errMsg });
					lastConflictReport = { changedFiles: [], conflicts: [] };
				}

				// Wire stateTracker conflict count for overlap conflicts
				const overlapConflicts = lastConflictReport.conflicts.filter(c => c.severity === "overlap");
				for (const c of overlapConflicts) {
					this.#activityLogger?.logConflict(c.file, c.writers, c.severity);
					for (const writerId of c.writers) {
						await this.#stateTracker.incrementConflict(writerId);
					}
				}

				// Emit file_change events for FileChangesPanel
				for (const f of lastConflictReport.changedFiles) {
					const writers = lastConflictReport.conflicts.filter(c => c.file === f).flatMap(c => c.writers);
					this.#activityLogger?.logFileChange(writers[0] ?? "unknown", f, "modified");
				}

				// 3. Collect worker output for review context (all rounds)
				lastAgentOutput = allAgentResults.map(r => `[${r.agent}] ${r.output.slice(0, 4000)}`).join("\n\n---\n\n");

				// Update todo statuses from worker round summaries
				if (this.#planContent && this.#stateTracker.state.todos && this.#stateTracker.state.todos.length > 0) {
					const updatedTodos = this.#todoTracker.updateFromWorkerOutput(
						lastAgentOutput,
						this.#stateTracker.state.todos,
					);
					await this.#stateTracker.updatePipeline({ todos: updatedTodos });
					this.#activityLogger?.logPhase("todo-updated");
				}

				// 4. Latent cloner gate: only review when workers failed to converge internally
				if (agentsConverged) {
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
							agentIds.map(id => [id, { status: "completed" as const, iteration: iter }]),
						),
					});
					// ── Verification hook ──
					if (this.#verificationHook && this.#loopConfig.verification) {
						const vResult = await this.#verificationHook.run(this.#loopConfig.verification.commands);
						if (!vResult.passed && this.#loopConfig.verification.blocking) {
							// Blocking failure → continue to next iteration instead of completing
							errors.push(`Verification failed (blocking) at iteration ${iter + 1}`);
							if (this.#loopConfig.snapshot?.rollbackOnVerificationFailure) {
								await this.#restoreSnapshot(workspace, snapshotId, iter, "Verification failure (blocking)");
							}
							continue;
						}
						// Clean up old snapshots on successful iteration
						await this.#cleanupSnapshots(workspace);
						return {
							status: "completed",
							iterations: iter + 1,
							reviewVerdicts: verdicts,
							errors,
							verificationResults: vResult,
						};
					}
					// Clean up old snapshots on successful iteration
					await this.#cleanupSnapshots(workspace);
					return {
						status: "completed",
						iterations: iter + 1,
						reviewVerdicts: verdicts,
						errors,
					};
				}

				// Workers did not converge — escalate to latent cloner review
				await this.#channel.broadcast(
					this.#reviewerId,
					`Swarm did not converge internally. Escalating to review (iteration ${iter + 1}).`,
				);

				// Progress: cloners reviewing
				for (const id of reviewerIds) {
					await this.#stateTracker.updateAgent(id, { status: "running", iteration: iter });
				}
				await this.#stateTracker.updatePipeline({ roundtablePhase: "Reviewers reviewing (escalation)" });
				this.#activityLogger?.logPhase("cloner-review", undefined, iter + 1);
				options.onProgress?.({
					iteration: iter,
					targetCount: this.#loopConfig.maxIterations,
					currentWave: 0,
					totalWaves: 1,
					agents: Object.fromEntries(reviewerIds.map(id => [id, { status: "running", iteration: iter }])),
				});

				// Spawn cloners to review (parallel)

				// P0-F: beforeClonerReview hook.
				await invokeHook(hooks, "beforeClonerReview", () =>
					hooks?.beforeClonerReview?.(iter, lastAgentOutput, pipelineCtx),
				);

				verdict = await this.#runClonerReview(
					reviewerIds,
					iter,
					lastAgentOutput,
					workspace,
					this.#planContent,
					clonerFeedbackHistory,
					modelRegistry,
					settings,
					iterSignal,
				);

				// P0-F: afterClonerReview hook.
				await invokeHook(hooks, "afterClonerReview", () => hooks?.afterClonerReview?.(iter, verdict, pipelineCtx));

				verdicts.push(verdict);

				// Save role suggestions for next iteration's workers (GAP 1)
				if (Object.keys(verdict.roleSuggestions).length > 0) {
					currentRoleSuggestions = verdict.roleSuggestions;
				}

				// Track worker quality from cloner verdict (GAP 3)
				if (verdict.praisedAgents.length > 0) {
					await this.#stateTracker.incrementPraise(verdict.praisedAgents);
				}
				if (verdict.criticizedAgents.length > 0) {
					await this.#stateTracker.incrementCriticism(verdict.criticizedAgents);
				}

				// Progress: cloners completed
				for (const id of reviewerIds) {
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
						...agentIds.map(id => [id, { status: "completed" as const, iteration: iter }]),
						...reviewerIds.map(id => [id, { status: "completed" as const, iteration: iter }]),
					]),
				});
				if (verdict.passed) {
					// ── Verification hook ──
					if (this.#verificationHook && this.#loopConfig.verification) {
						const vResult = await this.#verificationHook.run(this.#loopConfig.verification.commands);
						if (!vResult.passed && this.#loopConfig.verification.blocking) {
							// Blocking failure → continue to next iteration instead of completing
							errors.push(`Verification failed (blocking) at iteration ${iter + 1}`);
							if (this.#loopConfig.snapshot?.rollbackOnVerificationFailure) {
								await this.#restoreSnapshot(workspace, snapshotId, iter, "Verification failure (blocking)");
							}
							continue;
						}
						// Clean up old snapshots on successful iteration
						await this.#cleanupSnapshots(workspace);
						return {
							status: "completed",
							iterations: iter + 1,
							reviewVerdicts: verdicts,
							errors,
							verificationResults: vResult,
						};
					}
					// Clean up old snapshots on successful iteration
					await this.#cleanupSnapshots(workspace);
					return {
						status: "completed",
						iterations: iter + 1,
						reviewVerdicts: verdicts,
						errors,
					};
				}
			} catch (err) {
				// Release all region locks held by this iteration's workers.
				// A crash bypasses the normal releaseAll path (line ~619), leaking
				// locks into the next iteration where same-named workers would be
				// blocked on their own stale locks.
				for (const id of agentIds) lockMgr.releaseAll(id);

				const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
				const message = isTimeout
					? `Iteration ${iter + 1} timed out after ${this.#loopConfig.iterationTimeoutMs}ms`
					: `Iteration ${iter + 1} error: ${err instanceof Error ? err.message : String(err)}`;
				errors.push(message);

				// Notify the frontend so Timeline/Channels don't appear frozen.
				// Without this, the catch block silently swallows the error and
				// the GUI sees no post-worker events at all.
				await this.#stateTracker.updatePipeline({
					roundtablePhase: isTimeout ? "Timed out" : "Error — retrying",
				});
				this.#activityLogger?.logPhase("iteration-error", undefined, iter + 1);
				this.#activityLogger?.logBroadcast("system", message);

				// Rollback workspace on crash/timeout if configured
				if (this.#loopConfig.snapshot?.rollbackOnError) {
					await this.#restoreSnapshot(
						workspace,
						snapshotId,
						iter,
						`Error: ${err instanceof Error ? err.message : String(err)}`,
					);
				}

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
									lastAgentOutput,
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
				const resolution = await this.#detectBlockage(iter, verdict, lastAgentOutput);
				if (resolution === "abort") {
					return {
						status: "aborted",
						iterations: iter + 1,
						reviewVerdicts: verdicts,
						errors: [...errors, "Loop aborted by user via blocker resolution"],
					};
				}
				if (resolution === "skip") {
					// Rollback on skip if error rollback is configured
					if (this.#loopConfig.snapshot?.rollbackOnError) {
						await this.#restoreSnapshot(workspace, snapshotId, iter, "User chose to skip iteration");
					}
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
			{
				// Pure decision extracted to worker-scaler.ts (unit-tested).
				const delta = computeScaleDelta({
					suggestions,
					voterCount: reviewerIds.length,
					currentAgentCount,
					min,
				});

				if (delta > 0) {
					const addCount = Math.min(delta, max - currentAgentCount);
					for (let i = 0; i < addCount; i++) {
						const newId = `agent-${agentIds.length + 1}`;
						this.#channel.addAgent(newId);
						await this.#stateTracker.registerAgent(newId, this.#loopConfig.model);
						agentIds.push(newId);
						currentAgentCount++;
						this.#activityLogger?.logScaling("add", newId, `cloner suggestion +${delta}`);
					}
				} else if (delta < 0 && currentAgentCount > min) {
					const removeCount = Math.min(-delta, currentAgentCount - min);
					for (let i = 0; i < removeCount; i++) {
						// Quality-based scale-down: remove the lowest-scoring worker (GAP 3)
						const worst = this.#stateTracker.getWorstAgent(agentIds);
						const removed = worst ?? agentIds[agentIds.length - 1];
						const idx = agentIds.indexOf(removed);
						if (idx >= 0) agentIds.splice(idx, 1);
						this.#channel.removeAgent(removed);
						await this.#stateTracker.unregisterAgent(removed);
						this.#activityLogger?.logScaling("remove", removed, `cloner suggestion ${delta}`);
						currentAgentCount--;
					}
				}
			}

			// 6. Broadcast feedback and accumulate for cross-iteration memory
			const feedback = verdict.findings.join("\n");
			clonerFeedbackHistory.push(feedback);
			await this.#channel.broadcast(this.#reviewerId, `Review feedback (iteration ${iter + 1}):\n${feedback}`);

			// P0-F: afterIteration hook.
			await invokeHook(hooks, "afterIteration", () => hooks?.afterIteration?.(iter, pipelineCtx));

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
						lastAgentOutput,
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
			const status: LoopResult["status"] =
				!vResult.passed && this.#loopConfig.verification.blocking ? "failed" : "completed";
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
	 * - Sets phase to "blocked" via stateTracker.
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
		lastAgentOutput: string,
	): Promise<BlockerResolution> {
		// Pure blockage decision extracted to blockage.ts (unit-tested).
		const decision = evaluateBlockage({
			stagnationCount: this.#stagnationCount,
			agentCrashCounts: this.#agentCrashCounts,
		});

		if (!decision.blocked) {
			return "continue";
		}

		const reason = decision.reason!;

		this.#currentBlockerContext = {
			iteration: iteration + 1,
			lastFindings: verdict.findings,
			lastAgentOutput: lastAgentOutput.slice(0, 8000),
			stagnationCount: this.#stagnationCount,
			agentCrashCounts: { ...this.#agentCrashCounts },
			reason,
			timeoutMs: BLOCKER_TIMEOUT_MS,
			deadline: Date.now() + BLOCKER_TIMEOUT_MS,
		};

		// Set loop phase to blocked (state machine validates + broadcasts atomically;
		// onEnter derives roundtablePhase from ctx.reason and emits the phase event).
		await this.#setChapter("blocked", { reason, iteration: iteration + 1 });
		this.#activityLogger?.logBroadcast(
			"system",
			JSON.stringify({
				type: "blocker",
				context: this.#currentBlockerContext,
			}),
		);

		logger.warn(`Blockage detected at iteration ${iteration + 1}: ${reason}`);

		// Await user resolution with P2-4 timeout (5 min auto-degrade to continue).
		const resolution = await new Promise<BlockerResolution>(resolve => {
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
			await this.#setChapter("stage", { iteration: iteration + 1 });
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
			this.#agentCrashCounts = {};
		}

		this.#blockerResolver(decision);
		return true;
	}

	/** Track worker crashes for deadlock detection (called from #spawnWorkers error handler). */
	#trackWorkerCrash(agentId: string): void {
		this.#agentCrashCounts[agentId] = (this.#agentCrashCounts[agentId] ?? 0) + 1;
	}

	// -------------------------------------------------------------------
	// Git snapshot / rollback
	// -------------------------------------------------------------------

	/**
	 * Create a git snapshot before an iteration.
	 * Uses `git add -A && git commit` to capture current workspace state.
	 * Returns the snapshot ref (commit hash) or null if snapshots are disabled
	 * or the workspace is not a git repo.
	 */
	async #createSnapshot(workspace: string, iteration: number): Promise<string | null> {
		const cfg = this.#loopConfig.snapshot;
		if (!cfg?.enabled) return null;

		try {
			// Check if we're in a git repo
			const { exitCode: gitCheck } = Bun.spawnSync(["git", "-C", workspace, "rev-parse", "--git-dir"]);
			if (gitCheck !== 0) return null;

			// Stage all changes
			Bun.spawnSync(["git", "-C", workspace, "add", "-A"]);

			// Create snapshot commit (allow-empty for clean workspaces)
			const tag = `swarm-snapshot-iter-${iteration + 1}-${Date.now()}`;
			const { stdout } = Bun.spawnSync([
				"git",
				"-C",
				workspace,
				"commit",
				"--allow-empty",
				"-m",
				`swarm: snapshot before iteration ${iteration + 1}`,
			]);
			const commitHash = stdout?.toString().trim() || null;

			if (commitHash) {
				// Tag for easy reference
				Bun.spawnSync(["git", "-C", workspace, "tag", tag, commitHash]);
			}

			this.#activityLogger?.logBroadcast(
				"system",
				`[snapshot] Created snapshot for iteration ${iteration + 1}: ${commitHash ?? "(empty)"}`,
			);
			logger.info("Snapshot created", { iteration: iteration + 1, commit: commitHash });

			return commitHash;
		} catch (err) {
			logger.warn("Failed to create snapshot", { iteration, error: String(err) });
			return null;
		}
	}

	/**
	 * Restore workspace to a previously created snapshot.
	 * Uses `git reset --hard` to discard all changes since the snapshot.
	 */
	async #restoreSnapshot(
		workspace: string,
		snapshotId: string | null,
		iteration: number,
		reason: string,
	): Promise<boolean> {
		if (!snapshotId) return false;

		try {
			// Reset to the snapshot commit
			Bun.spawnSync(["git", "-C", workspace, "reset", "--hard", snapshotId]);

			// Clean untracked files
			Bun.spawnSync(["git", "-C", workspace, "clean", "-fd"]);

			this.#activityLogger?.logBroadcast("system", `[rollback] Iteration ${iteration + 1} rolled back: ${reason}`);
			logger.warn("Snapshot restored", { iteration: iteration + 1, reason });

			return true;
		} catch (err) {
			logger.warn("Failed to restore snapshot", { iteration, error: String(err) });
			return false;
		}
	}

	/**
	 * Clean up old snapshots beyond maxSnapshots.
	 */
	async #cleanupSnapshots(workspace: string): Promise<void> {
		const cfg = this.#loopConfig.snapshot;
		if (!cfg?.enabled || !cfg?.maxSnapshots) return;

		try {
			// List swarm snapshot tags, oldest first
			const { stdout } = Bun.spawnSync([
				"git",
				"-C",
				workspace,
				"tag",
				"-l",
				"swarm-snapshot-iter-*",
				"--sort=creatordate",
			]);
			const tags = stdout?.toString().trim().split("\n").filter(Boolean) || [];

			// Delete tags beyond maxSnapshots (keep newest)
			const toDelete = tags.slice(0, Math.max(0, tags.length - cfg.maxSnapshots));
			for (const tag of toDelete) {
				Bun.spawnSync(["git", "-C", workspace, "tag", "-d", tag]);
			}
		} catch (err) {
			logger.warn("Failed to cleanup snapshots", { error: String(err) });
		}
	}

	// -------------------------------------------------------------------
	// Spawn workers in parallel
	// -------------------------------------------------------------------
	async #spawnWorkers(
		agentIds: string[],
		workspace: string,
		planContent: string | undefined,
		previousFeedback: string[],
		modelRegistry: ModelRegistry | undefined,
		settings: Settings | undefined,
		signal: AbortSignal | undefined,
		errors: string[] = [],
		extraContext: string | undefined,
		roleSuggestions: Record<string, string> | undefined,
		lockMgr: RegionLockManager | undefined,
		channel: AgentChannel | undefined,
		reviewerId: string | undefined,
		nominationPrompt: string | undefined,
		iteration: number,
		/** P7: Per-agent context provider (Profile + Stigmergy injection). */
		getAgentContext?: ((agentId: string) => string | null),
	): Promise<SingleResult[]> {
		const feedbackBlock =
			previousFeedback.length > 0
				? `\n## Previous Review Feedback\n\n${previousFeedback.map((f, i) => `(Iteration ${i + 1}) ${f}`).join("\n")}\n`
				: "";

		// Build lock hooks shared across workers when lockMgr is active.
		const hooks = lockMgr && channel ? (id: string) => this.#buildLockHooks(id, lockMgr, channel) : undefined;

		const results = await Promise.allSettled(
			agentIds.map((id, i) => {
				const workerHooks = hooks?.(id);
				const isReviewer = reviewerId !== undefined && id === reviewerId;
				const systemPrompt = isReviewer
					? `${AGENT_SYSTEM_PROMPT}\n${AgentChannel.buildReviewerPrompt()}`
					: AGENT_SYSTEM_PROMPT;

				const agentDef: AgentDefinition = {
					name: id,
					description: `Loop Engineering Worker ${i + 1}`,
					systemPrompt,
					source: "project" as const,
				};
				applyToolRestrictions(agentDef, resolveToolRestrictions(this.#loopConfig, "worker"));

				const taskText = [
					`You are Worker ${i + 1} of ${agentIds.length}.`,
					`Your peers are: ${agentIds.filter(w => w !== id).join(", ")}.`,
					`Negotiate with them via IRC (use \`irc send to:worker:*\` for broadcast).`,
					`Work in the workspace: ${workspace}.`,
					planContent ? `\n## Plan\n\n${planContent}` : "",
					feedbackBlock,
					roleSuggestions?.[id]
						? `\n## Role\n\nreview suggests your role for this round: **${roleSuggestions[id]}**.\nThis is non-binding — coordinate with peers to confirm your approach.\n`
						: "",
					nominationPrompt ?? "",
					// P7: Per-agent context injection (Profile + Stigmergy).
					getAgentContext?.(id) ?? "",
					extraContext ?? "",
				].join("\n");

				// ── Route through the AgentExecutor (pipeline-aligned) ──
				// Uses agentOverrides.systemPrompt to inject the full worker
				// system prompt on top of the auto-built "You are a {role}."
				// prefix. timeoutMs:0 disables per-worker timeout — iteration-
				// level signal handles cancellation. Tool restrictions flow
				// through SwarmAgent.allowedTools/blockedTools.
				const swarmAgent: SwarmAgent = {
					name: id,
					role: `Loop Engineering Worker ${i + 1}`,
					task: taskText,
					reportsTo: [],
					waitsFor: [],
					...(agentDef.tools?.length ? { allowedTools: agentDef.tools as string[] } : {}),
					...(agentDef.blockedTools?.length ? { blockedTools: agentDef.blockedTools as string[] } : {}),
				};

				return this.#executor.execute(swarmAgent, i, {
					workspace,
					swarmName: this.#stateTracker.state.name,
					iteration,
					modelRegistry,
					settings,
					signal,
					timeoutMs: 0,
					stateTracker: this.#stateTracker,
					agentOverrides: {
						systemPrompt,
						source: "project" as const,
					},
					toolHooks: {
						beforeToolCall: workerHooks?.beforeToolCall,
						afterToolCall: workerHooks?.afterToolCall,
					},
					activityLogger: this.#activityLogger,
				}).then(
					result => result,
					err => {
						if (lockMgr) lockMgr.releaseAll(id);
						throw err;
					},
				);
			}),
		);

		return results.map((r, i) => {
			if (r.status === "fulfilled") return r.value;
			const errMsg = r.reason instanceof Error ? r.reason.message : String(r.reason);
			errors.push(`Worker ${agentIds[i]} crashed: ${errMsg}`);
			this.#trackWorkerCrash(agentIds[i]);
			this.#activityLogger?.logCrash(agentIds[i], errMsg);
			return {
				index: i,
				id: agentIds[i],
				agent: agentIds[i],
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
	#buildLockHooks(agentId: string, lockMgr: RegionLockManager, channel: AgentChannel) {
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
			const check = lockMgr.checkLock(file, agentId);
			if (check.locked && check.entry) {
				void channel.broadcast(
					agentId,
					`[BLOCKED] ${agentId} wants ${file} but ${RegionLockManager.describeLock(check.entry)}.`,
				);
				return {
					block: true as const,
					reason: `File locked: ${RegionLockManager.describeLock(check.entry)}. Use IRC to negotiate.`,
				};
			}

			// Tier 2: acquire lock before tool executes
			if (!lockMgr.tryLock(agentId, file)) {
				return {
					block: true as const,
					reason: `Cannot acquire lock on ${file} — concurrent edit conflict. Retry or negotiate via IRC.`,
				};
			}

			// Tier 1: broadcast editing intent
			void channel.broadcast(agentId, `[EDITING] ${agentId} started editing ${file}.`);

			return undefined;
		};

		const afterToolCall: AgentLoopConfig["afterToolCall"] = ctx => {
			const name = ctx.toolCall.name;
			if (!EDIT_TOOLS.has(name)) return undefined;

			const file = extractPath(name, ctx.args);
			if (!file) return undefined;

			lockMgr.release(agentId, file);
			void channel.broadcast(agentId, `[DONE] ${agentId} finished editing ${file}.`);

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
		agentIds: string[],
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
				agentIds.map((id, i) => {
					const delibMsgId = `deliberation-${id}-${sub}`;
					return streamAgentOutput(
						{ activityLogger: this.#activityLogger!, msgId: delibMsgId, from: id },
						{
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
					});
				}),
			);

			currentOutputs = subResults.map((r, i) => {
				if (r.status === "fulfilled") return r.value;
				const errMsg = r.reason instanceof Error ? r.reason.message : String(r.reason);
				errors.push(`Deliberation worker ${agentIds[i]} crashed: ${errMsg}`);
				return (
					currentOutputs[i] ?? {
						index: i,
						id: `deliberation-${agentIds[i]}`,
						agent: agentIds[i],
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
	// -------------------------------------------------------------------
	// Cloner review — deprecated stub.
	// In the new StageController model, review is embedded in the TaskQueue
	// (review tasks claimed by reviewer-role agents). This stub returns
	// a generic pass verdict for backward compat with LoopController callers.
	// -------------------------------------------------------------------
	async #runClonerReview(
		reviewerIds: string[],
		_iteration: number,
		_agentOutput: string,
		_workspace: string,
		_planContent: string | undefined,
		_previousFindings: string[],
		_modelRegistry?: ModelRegistry,
		_settings?: Settings,
		_signal?: AbortSignal,
	): Promise<ReviewVerdict> {
		return {
			passed: true,
			approvalCount: reviewerIds.length,
			totalCount: reviewerIds.length,
			findings: [],
			workerCountSuggestions: [],
			disagreed: false,
			roleSuggestions: {},
			praisedAgents: [],
			criticizedAgents: [],
		};
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
	hooks?: LoopPipelineHooks;
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
