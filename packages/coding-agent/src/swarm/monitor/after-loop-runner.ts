/**
 * AfterLoopRunner — extracted from SwarmRunManager.#runAfterLoopPipeline.
 *
 * Handles the post-loop pipeline: verification → lesson extraction →
 * deep reflection → saving → summarizing → archiving.
 */
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { StateTracker } from "../state";
import { ActivityLogger } from "../activity-logger";
import { ExperienceStore, extractLessons, reflectDeep, reflectionToLesson, generateRunSummary } from "../after-loop";
import { VerificationHook } from "../verification-hook";
import type { LoopResult } from "../loop-controller";
import type { LoopSwarmConfig } from "../schema";
import type { AfterLoopResult } from "./types";

export interface AfterLoopRunnerOpts {
  workspace: string;
  stateTracker: StateTracker;
  activityLogger: ActivityLogger;
  experienceStore: ExperienceStore;
  loopConfig: LoopSwarmConfig | null;
  modelRegistry: import("../../config/model-registry").ModelRegistry;
  settings: import("../../config/settings").Settings;
  loopController: ReturnType<typeof import("../loop-controller").createLoopController>;
  abortController: AbortController | null;
}

export async function runAfterLoopPipeline(
  result: LoopResult,
  opts: AfterLoopRunnerOpts,
): Promise<AfterLoopResult | null> {
  const {
    workspace, stateTracker, activityLogger, experienceStore,
    loopConfig, modelRegistry, settings, loopController, abortController,
  } = opts;

  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  logger.info("[AfterLoop] Pipeline starting", { runId });

  // -- Verification hook --
  if (loopConfig?.verification?.commands?.length) {
    let vResult = result.verificationResults;
    if (!vResult) {
      const hook = new VerificationHook(workspace, activityLogger);
      vResult = await hook.run(loopConfig.verification.commands);
      result.verificationResults = vResult;
    }
    if (!vResult.passed && loopConfig.verification.blocking) {
      logger.info("[AfterLoop] Verification failed (blocking) — returning to running");
      activityLogger.logBroadcast("system", "[verification] Blocking failure — returning to running for another iteration");
      await stateTracker.updatePipeline({ phase: "stage", status: "running", roundtablePhase: "Verification failed — re-running" });
      activityLogger.logPhase("loop-start");
      try {
        const restartResult = await loopController.runLoop({
          workspace,
          modelRegistry,
          settings,
          signal: abortController?.signal,
        });
        return runAfterLoopPipeline(restartResult, opts);
      } catch (err) {
        logger.error("[AfterLoop] Verification restart loop failed", { error: String(err) });
      }
      return null;
    }
  }

  try {
    // 1. Phase → after-loop
    await stateTracker.updatePipeline({ roundtablePhase: "Curtain: extracting lessons", phase: "curtain" });
    activityLogger.logPhase("curtain", undefined, result.iterations);

    // 2. Agent counts
    const agents = stateTracker.state.agents;
    const workerCount = Object.values(agents).filter(a => a.name.startsWith("worker")).length;
    const clonerCount = Object.values(agents).filter(a => a.name.startsWith("cloner")).length;

    // 3. Extract lessons
    const extraction = extractLessons(result, workerCount, clonerCount);
    logger.info("[AfterLoop] Extracted lessons", { count: extraction.lessons.length });

    await stateTracker.updatePipeline({ roundtablePhase: "Curtain: deep reflection" });

    // 4. Deep reflection (LLM, best-effort)
    let reflection = null;
    try {
      reflection = await reflectDeep(result, extraction, { registry: modelRegistry, settings });
      if (reflection) {
        logger.info("[AfterLoop] Deep reflection completed", { confidence: reflection.confidence });
        const reflectionLesson = reflectionToLesson(reflection, runId);
        extraction.lessons.push(reflectionLesson);
      } else {
        logger.info("[AfterLoop] Deep reflection returned null (skipped)");
      }
    } catch (reflectErr) {
      logger.warn("[AfterLoop] Deep reflection failed", { error: String(reflectErr) });
    }

    await stateTracker.updatePipeline({ roundtablePhase: "Curtain: saving experience" });

    // 5. Save lessons
    const referencedRunIds: string[] = [];
    for (const lesson of extraction.lessons) {
      experienceStore.saveLesson({
        runId: `${runId}-${lesson.type}`,
        timestamp: new Date().toISOString(),
        lesson,
        stats: extraction.stats,
        weight: 1.0,
      });
      referencedRunIds.push(`${runId}-${lesson.type}`);
    }
    logger.info("[AfterLoop] Saved lessons to ExperienceStore", { count: extraction.lessons.length });

    // 6. Generate summary
    const summary = generateRunSummary(runId, extraction);
    await experienceStore.writeSummary(runId, summary.markdown);
    logger.info("[AfterLoop] Summary written", { path: `.omp/experience/summaries/${runId}.md` });

    // 7. Archive plan.md — plan lives in per-session swarm dir, archives in workspace .omp/plans/
    await stateTracker.updatePipeline({ roundtablePhase: "Curtain: archiving plan" });
    try {
      const { archivePlanForHistory } = await import("../script-planner");
      await archivePlanForHistory(stateTracker.swarmDir, workspace);
      logger.info("[AfterLoop] plan.md archived to .omp/plans/");
    } catch (archiveErr) {
      logger.warn("[AfterLoop] Plan archival failed", { error: String(archiveErr) });
    }

    // 8. Decay unreferenced
    experienceStore.decayUnreferenced(referencedRunIds);

    // 9. Build result
    const afterLoopResult: AfterLoopResult = {
      runId,
      status: result.status,
      iterations: result.iterations,
      summaryMarkdown: summary.markdown,
      lessons: extraction.lessons,
      reflection: reflection ? {
        rootCauses: reflection.rootCauses,
        effectivePatterns: reflection.effectivePatterns,
        structuralIssues: reflection.structuralIssues,
        recommendations: reflection.recommendations,
        confidence: reflection.confidence,
      } : null,
      stats: {
        totalIterations: extraction.stats.totalIterations,
        finalStatus: extraction.stats.finalStatus,
        clonerApprovalRatio: extraction.stats.clonerApprovalRatio,
        workerCount: extraction.stats.workerCount,
        clonerCount: extraction.stats.clonerCount,
      },
    };

    // 10. Phase → completed
    await stateTracker.updatePipeline({ roundtablePhase: "After Loop completed", phase: "idle", status: "completed" });
    activityLogger.logPhase("after-loop-done", undefined, result.iterations);

    logger.info("[AfterLoop] Pipeline completed successfully");
    return afterLoopResult;
  } catch (afterLoopErr) {
    logger.error("[AfterLoop] Pipeline failed", { error: String(afterLoopErr) });
    await stateTracker.updatePipeline({ roundtablePhase: "After Loop failed", phase: "idle", status: "failed" });
    return null;
  }
}
