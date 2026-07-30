/**
 * CurtainTransition — shared curtain pipeline finalization.
 *
 * Extracted from GraphRunner (confirmScript, resumeGraphRun) and
 * EmbeddedSwarmBridge (#runCurtain) which each duplicated the pattern:
 *   build StageResult → runCurtainPipeline → FSM transition to idle.
 */

import type { GraphRunResult } from "../../graph/graph-engine";
import type { SingleResult } from "../../task";
import type { CurtainResultData, CurtainRunnerOpts } from "../curtain/curtain-runner";
import { runCurtainPipeline } from "../curtain/curtain-runner";
import type { StageResult } from "../stage/stage-controller";
import type { WorkflowFsm } from "./workflow-fsm";

// ============================================================================
// StageResult builder (GraphRunner path)
// ============================================================================

/**
 * Build a {@link StageResult}-compatible object from a GraphEngine run result.
 * Converts per-node results into the agentResults map expected by the curtain pipeline.
 */
export function buildStageResultFromGraphRun(
	graphRunResult: GraphRunResult,
	getNodeDescription: (nodeId: string) => string,
): StageResult {
	const allSucceeded = graphRunResult.executionErrors.length === 0;
	const agentResults = new Map<string, SingleResult[]>();

	for (const [nodeId, nodeResult] of graphRunResult.nodeResults) {
		agentResults.set(nodeId, [
			{
				index: 0,
				id: nodeId,
				agent: nodeId,
				agentSource: "project",
				task: getNodeDescription(nodeId),
				exitCode: nodeResult.success ? 0 : 1,
				output: nodeResult.output ?? "",
				stderr: nodeResult.error ?? "",
				truncated: false,
				durationMs: 0,
				tokens: 0,
				requests: 0,
			},
		]);
	}

	return {
		status: allSucceeded ? "completed" : "failed",
		agentResults,
		errors: graphRunResult.executionErrors,
		agents: graphRunResult.agentsList,
		taskProgress: { total: graphRunResult.totalNodes, completed: graphRunResult.completedCount },
		degradedMode: [],
	};
}

// ============================================================================
// Curtain → Idle transition
// ============================================================================

/**
 * Run the curtain pipeline and transition the FSM to idle.
 *
 * Shared by GraphRunner (no applaud wait) and EmbeddedSwarmBridge
 * (applaud wait passed via `preIdleHook`).
 *
 * @param result      - Stage execution result (agent outputs, errors, progress).
 * @param opts        - Curtain pipeline options (workspace, stores, registries, etc.).
 * @param fsm         - The workflow FSM to transition to idle.
 * @param idleReason  - Reason metadata for the FSM idle transition.
 * @param preIdleHook - Optional async hook run after curtain pipeline but before
 *                       the idle transition (used for human applaud wait).
 * @returns The curtain result data (summary, lessons, reflection), or null if skipped.
 */
export async function transitionToCurtainAndIdle(
	result: StageResult,
	opts: CurtainRunnerOpts,
	fsm: WorkflowFsm,
	idleReason: string,
	preIdleHook?: () => Promise<void>,
): Promise<CurtainResultData | null> {
	const curtainResult = await runCurtainPipeline(result, opts);
	if (preIdleHook) await preIdleHook();
	await fsm.transition("idle", { reason: idleReason });
	return curtainResult;
}
