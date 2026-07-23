/**
 * CurtainRunner — manages the Curtain (closing) phase.
 *
 * Runs in parallel:
 *   Thread A: Reporter agent delivers build summary to user
 *   Thread B: Reflection agents extract lessons, discuss, update profiles
 *
 * After both complete, waits for user to "Applaud" before finalizing.
 */

import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { StateTracker } from "../state";
import { ActivityLogger } from "../activity-logger";
import { ExperienceStore, extractLessons, reflectDeep, reflectionToLesson, generateRunSummary } from "../curtain";
import { VerificationHook } from "../verification-hook";
import { streamAgentOutput } from "../streaming";
import type { LoopResult } from "../loop-controller";
import type { LoopSwarmConfig } from "../schema";
import type { AfterLoopResult } from "./types";
import type { RoleAssetManager } from "../role-asset";
import type { ProfileRegistry } from "../agent-profile";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

export interface CurtainRunnerOpts {
	workspace: string;
	stateTracker: StateTracker;
	activityLogger: ActivityLogger;
	experienceStore: ExperienceStore;
	loopConfig: LoopSwarmConfig | null;
	modelRegistry: ModelRegistry;
	settings: Settings;
	roleAssetManager?: RoleAssetManager;
	profileRegistry?: ProfileRegistry;
	/** Promise that resolves when user applauds. Set up by the API endpoint. */
	applaudSignal?: AbortSignal;
}

export interface CurtainResultData {
	runId: string;
	status: string;
	iterations: number;
	summaryMarkdown: string;
	lessons: import("../after-loop/experience").ExperienceLesson[];
	reflection: {
		rootCauses: string[];
		effectivePatterns: string[];
		structuralIssues: string[];
		recommendations: string[];
		confidence: number;
	} | null;
	stats: {
		totalIterations: number;
		finalStatus: string;
		reviewApprovalRatio: number;
		agentCount: number;
		
	};
}

// ============================================================================
// CurtainRunner
// ============================================================================

/**
 * Run the Curtain phase: reporter agent + parallel reflection.
 */
export async function runCurtainPipeline(
	result: LoopResult,
	opts: CurtainRunnerOpts,
): Promise<CurtainResultData | null> {
	const {
		workspace, stateTracker, activityLogger, experienceStore,
		loopConfig, modelRegistry, settings, roleAssetManager, profileRegistry,
	} = opts;

	const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	logger.info("[Curtain] Phase starting", { runId });

	// ── Phase: curtain ──
	await stateTracker.updatePipeline({ phase: "curtain", roundtablePhase: "Curtain: summarizing" });
	activityLogger.logPhase("curtain", undefined, result.iterations);

	// Agent counts
	const agents = stateTracker.state.agents;
		const agentCount = Object.keys(agents).length;
		const reviewerCount = Object.values(agents).filter(a => a.role === "reviewer").length;

	// ── Run reporter + reflection in parallel ──
	const [reporterSummary, extraction] = await Promise.all([
		// Thread A: Reporter agent
		runReporterAgent(workspace, result, { modelRegistry, settings, activityLogger, roleAssetManager }),
		// Thread B: Reflection pipeline
	]);

	// ── Merge results ──
	await stateTracker.updatePipeline({ roundtablePhase: "Curtain: building summary" });

	const summaryMarkdown = [
		reporterSummary ?? "No reporter output.",
		"",
		"---",
		"",
		extraction.reflectionSummary,
	].join("\n");

	// Save lessons
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

	// Write summary
	await experienceStore.writeSummary(runId, summaryMarkdown);
	experienceStore.decayUnreferenced(referencedRunIds);

	// Archive plan
	try {
		const { archivePlanForHistory } = await import("../script-planner");
		await archivePlanForHistory(stateTracker.swarmDir, workspace);
	} catch (err) {
		logger.warn("[Curtain] Plan archival failed", { error: String(err) });
	}

	const curtainResult: CurtainResultData = {
		runId,
		status: result.status,
		iterations: result.iterations,
		summaryMarkdown,
		lessons: extraction.lessons,
		reflection: extraction.deepReflection
			? {
				rootCauses: extraction.deepReflection.rootCauses,
				effectivePatterns: extraction.deepReflection.effectivePatterns,
				structuralIssues: extraction.deepReflection.structuralIssues,
				recommendations: extraction.deepReflection.recommendations,
				confidence: extraction.deepReflection.confidence,
			}
			: null,
		stats: {
			totalIterations: extraction.stats.totalIterations,
			finalStatus: extraction.stats.finalStatus,
			reviewApprovalRatio: extraction.stats.reviewApprovalRatio,
			agentCount: extraction.stats.agentCount,
		},
	};

	// Phase complete — wait for applaud
	await stateTracker.updatePipeline({ phase: "curtain", roundtablePhase: "Curtain: awaiting applaud" });
	activityLogger.logPhase("curtain-done", undefined, result.iterations);

	logger.info("[Curtain] Phase completed successfully");
	return curtainResult;
}

// ============================================================================
// Reporter agent — summarizes build results for the user
// ============================================================================

async function runReporterAgent(
	workspace: string,
	result: LoopResult,
	opts: {
		modelRegistry: ModelRegistry;
		settings: Settings;
		activityLogger: ActivityLogger;
		roleAssetManager?: RoleAssetManager;
	},
): Promise<string | null> {
	const { modelRegistry, settings, activityLogger, roleAssetManager } = opts;

	// Load reporter role
	let reporterPrompt: string | undefined;
	try {
		const role = await roleAssetManager?.get("reporter");
		if (role?.status === "approved") {
			reporterPrompt = role.prompts.system;
		}
	} catch { /* use default */ }

	const systemPrompt = reporterPrompt ??
		"You are a Reporter agent. Summarize the completed build for the user. Be clear, concise, and honest about issues.";

	try {
		const msgId = `curtain-reporter-${Date.now()}`;
		const report = await streamAgentOutput(
			{ activityLogger, msgId, from: "reporter" },
			{
				cwd: workspace,
				agent: {
					name: "reporter",
					description: "Curtain phase reporter agent",
					systemPrompt,
					source: "project" as const,
					tools: ["read", "grep", "glob"],
				},
				task: [
					"## Build Complete — Report to User",
					"",
					`Status: ${result.status}`,
					`Iterations: ${result.iterations}`,
					"",
					"## Instructions",
					"1. Check workspace for files created/modified",
					"2. Report a summary: what was built, key files, test results, known issues",
					"3. Be honest — if something is incomplete, say so",
					"4. Structure for readability (sections, bullet points)",
				].join("\n"),
				index: 0,
				id: msgId,
				modelRegistry,
				settings,
			},
		);

		return report.output || null;
	} catch (err) {
		logger.warn("[Curtain] Reporter agent failed", { error: String(err) });
		return `Build completed (${result.status}). Unable to generate detailed report.`;
	}
}

// ============================================================================
// Reflection pipeline — extract + reflect + summarize
// ============================================================================

interface ReflectionResult {
	lessons: import("../after-loop/experience").ExperienceLesson[];
	stats: {
		totalIterations: number;
		finalStatus: string;
		reviewApprovalRatio: number;
		agentCount: number;
		
	};
	reflectionSummary: string;
	deepReflection: Awaited<ReturnType<typeof reflectDeep>> | null;
}

async function runReflectionPipeline(
	result: LoopResult,
	opts: {
		agentCount: number;
		
		experienceStore: ExperienceStore;
		modelRegistry: ModelRegistry;
		settings: Settings;
		runId: string;
	},
): Promise<ReflectionResult> {
	const { agentCount, experienceStore, modelRegistry, settings, runId } = opts;

	// Extract lessons
	const extraction = extractLessons(result, agentCount, reviewerCount);

	// Deep reflection (LLM, best-effort)
	let deepReflection: Awaited<ReturnType<typeof reflectDeep>> | null = null;
	try {
		deepReflection = await reflectDeep(result, extraction, { registry: modelRegistry, settings });
		if (deepReflection) {
			logger.info("[Curtain] Deep reflection completed", { confidence: deepReflection.confidence });
			const reflectionLesson = reflectionToLesson(deepReflection, runId);
			extraction.lessons.push(reflectionLesson);
		}
	} catch (err) {
		logger.warn("[Curtain] Deep reflection failed", { error: String(err) });
	}

	// Generate summary
	const summary = generateRunSummary(runId, extraction);

	return {
		lessons: extraction.lessons,
		stats: extraction.stats,
		reflectionSummary: summary.markdown,
		deepReflection,
	};
}
