/**
 * Pipeline types — shared between swarm core and offload subsystems.
 *
 * Extracted from the now-removed pipeline.ts (PipelineController was deprecated
 * in favor of GraphRunner + PhaseBehavior). These types are still used by the
 * offload hooks and deduplicator pipeline.
 */

import type { SingleResult } from "@satopi/pi-coding-agent";

// ============================================================================
// ReviewVerdict — result of a review/debate phase.
// ============================================================================

export interface ReviewVerdict {
	passed: boolean;
	approvalCount: number;
	totalCount: number;
	findings: string[];
	/** Reviewer-suggested agent count deltas for next iteration. */
	agentCountSuggestions: number[];
	/** True when findings across reviewers diverge significantly. */
	disagreed: boolean;
	/** Agent IDs praised by reviewers this round. */
	praisedAgents: string[];
	/** Agent IDs criticized by reviewers this round. */
	criticizedAgents: string[];
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
// PipelineResult
// ============================================================================

export interface PipelineResult {
	status: "completed" | "failed" | "aborted";
	iterations: number;
	agentResults: Map<string, SingleResult[]>;
	errors: string[];
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
	beforeIteration?: (iteration: number, ctx: PipelineContext) => Promise<boolean | undefined>;
	/** Called after each iteration completes. */
	afterIteration?: (iteration: number, ctx: PipelineContext) => Promise<void>;
	/** Called before each wave executes. Return false to skip the wave. */
	beforeWave?: (waveIdx: number, agents: string[], ctx: PipelineContext) => Promise<boolean | undefined>;
	/** Called after each wave completes. */
	afterWave?: (waveIdx: number, waveResult: WaveResult, ctx: PipelineContext) => Promise<void>;
	/** Called on pipeline completion (all iterations done). */
	afterPipeline?: (status: PipelineResult["status"], ctx: PipelineContext) => Promise<void>;
	/** Called when a hook throws. Receives the hook name and error. */
	onHookError?: (hookName: string, error: unknown) => void;
}

/**
 * Extended lifecycle hooks for LoopController.
 *
 * Adds loop-specific events (agent rounds, deliberation, review)
 * on top of the base {@link PipelineHooks}.
 */
export interface LoopPipelineHooks extends PipelineHooks {
	/** Called before each agent round within an iteration. Return false to skip. */
	beforeAgentRound?: (round: number, agentIds: string[], ctx: PipelineContext) => Promise<boolean | undefined>;
	/** Called after each agent round completes. */
	afterAgentRound?: (round: number, results: SingleResult[], ctx: PipelineContext) => Promise<void>;
	/** Called before deliberation phase starts. */
	beforeDeliberation?: (round: number, ctx: PipelineContext) => Promise<void>;
	/** Called after deliberation phase completes. */
	afterDeliberation?: (round: number, results: SingleResult[], ctx: PipelineContext) => Promise<void>;
	/** Called before review starts. */
	beforeReview?: (iteration: number, agentOutput: string, ctx: PipelineContext) => Promise<void>;
	/** Called after review completes. */
	afterReview?: (iteration: number, verdict: ReviewVerdict | null, ctx: PipelineContext) => Promise<void>;
}
