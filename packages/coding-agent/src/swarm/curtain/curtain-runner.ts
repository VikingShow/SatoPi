/**
 * CurtainRunner — manages the Curtain (closing) phase.
 *
 * Runs in parallel:
 *   Thread A: Reporter agent delivers build summary to user
 *   Thread B: Reflection agents extract lessons, discuss, update profiles
 *
 * After both complete, waits for user to "Applaud" before finalizing.
 */

import type { ModelRegistry, Settings } from "@satopi/pi-coding-agent";
import { logger, prompt } from "@satopi/pi-utils";
import type { ProfileRegistry } from "../../agent/agent-profile";
import type { RoleAssetManager } from "../../agent/role-asset";
import { IrcBus } from "../../irc/bus";
import { enqueueMemoryConsolidation } from "../../memories";
import type { AgentRuntime } from "../agent-runtime";
import type { AgentSpec } from "../agent-runtime/agent-spec";
import type { LoopSwarmConfig } from "../core/schema";
import type { StateTracker } from "../core/state";
import {
	type DeepReflection,
	type ExperienceStore,
	type ExtractedLesson,
	extractLessons,
	generateRunSummary,
	type LoopRunStats,
	reflectDeep,
	reflectionToLesson,
} from "../curtain";
import type { ActivityLogger } from "../infra/activity-logger";
import type { SwarmHindsightClient } from "../infra/hindsight-adapter";
import type { MnemopiClient } from "../infra/mnemopi-adapter";
import curtainReporterPrompt from "../prompts/curtain-reporter.md" with { type: "text" };
import { archivePlanForHistory } from "../script/script-planner";
import type { StageResult } from "../stage/stage-controller";
import { MultiLessonSink } from "./lesson-sink";
import type { ContributionData } from "./types";

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
	/** Optional IRC bus for agent-to-agent communication (enables reporter election). */
	ircBus?: IrcBus;
	/** AgentRuntime for v3 agent spawning. */
	runtime?: AgentRuntime;
	/** Optional remote Hindsight handle — pushes lessons cross-session. Null/absent → local only. */
	hindsightClient?: SwarmHindsightClient | null;
	/** Optional semantic memory handle — pushes lessons to Mnemopi. Null/absent → skipped. */
	mnemopiClient?: MnemopiClient | null;
	/** Promise that resolves when user applauds. Set up by the API endpoint. */
	applaudSignal?: AbortSignal;
	/** Graph name — scopes lessons to a specific graph definition at runtime. */
	graphName?: string;
}

export interface CurtainResultData {
	runId: string;
	status: string;
	totalTasks: number;
	summaryMarkdown: string;
	lessons: ExtractedLesson[];
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
	result: StageResult,
	opts: CurtainRunnerOpts,
): Promise<CurtainResultData | null> {
	const {
		workspace,
		stateTracker,
		activityLogger,
		experienceStore,
		loopConfig: _loopConfig,
		modelRegistry,
		settings,
		roleAssetManager,
		profileRegistry: _profileRegistry,
		ircBus,
		hindsightClient,
		mnemopiClient,
	} = opts;

	const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	logger.info("[Curtain] Phase starting", { runId });

	// ── Phase: curtain ──
	await stateTracker.updatePipeline({ phase: "curtain", roundtablePhase: "Curtain: summarizing" });
	activityLogger.logPhase("curtain", undefined, result.taskProgress.total);

	// Agent counts
	const agents = stateTracker.state.agents;
	const agentCount = Object.keys(agents).length;

	// ── Elect reporter via agent voting (if IRC bus available) ──
	let electedReporter: string | null = null;
	if (ircBus && result.agentResults.size > 0) {
		try {
			const contributions: ContributionData[] = [];
			for (const [agentId, agentResults] of result.agentResults) {
				contributions.push({
					agentId,
					name: agents[agentId]?.name ?? agentId,
					tasksCompleted: agentResults.filter(r => r.exitCode === 0).length,
					codeLinesChanged: 0, // Not tracked in SingleResult
				});
			}
			const eligibleIds = contributions.map(c => c.agentId);
			const ircBus = opts.ircBus ?? IrcBus.global();
			const channel = ircBus.groupChannel("election", eligibleIds, activityLogger);
			const voteResult = await channel.vote("elect reporter", { eligibleIds, timeoutMs: 15000 });
			electedReporter = voteResult.winner;
			activityLogger.logBroadcast(
				"system",
				`Elected reporter: ${electedReporter} (deputies: ${voteResult.deputyIds.join(", ")})`,
			);
			logger.info("[Curtain] Reporter elected", { reporter: electedReporter });
		} catch (err) {
			logger.warn("[Curtain] Reporter election failed, falling back to default reporter", { error: String(err) });
		}
	}
	const [reporterSummary, extraction] = await Promise.all([
		// Thread A: Reporter agent (elected or default)
		runReporterAgent(
			workspace,
			result,
			{
				modelRegistry,
				settings,
				activityLogger,
				roleAssetManager,
				reporterOverride: electedReporter,
			},
			opts.runtime,
		),
		// Thread B: Reflection pipeline
		runReflectionPipeline(result, {
			agentCount,
			experienceStore,
			modelRegistry,
			settings,
			runId,
		}),
	]);

	// ── Merge results ──
	await stateTracker.updatePipeline({ roundtablePhase: "Curtain: building summary" });

	const summaryMarkdown = [reporterSummary ?? "No reporter output.", "", "---", "", extraction.reflectionSummary].join(
		"\n",
	);

	// Save lessons — fan out to ExperienceStore (authoritative) + remote/vector
	// backends (best-effort). referencedRunIds mirror the ExperienceStore runId
	// convention and drive decayUnreferenced below.
	const referencedRunIds: string[] = extraction.lessons.map(lesson => `${runId}-${lesson.type}`);
	const lessonSink = MultiLessonSink.create({ experienceStore, hindsightClient, mnemopiClient });
	const fanOutMetadata = opts.graphName ? { graphName: opts.graphName } : undefined;
	await lessonSink.fanOut(extraction.lessons, extraction.stats, runId, fanOutMetadata);

	// Trigger memory consolidation so experience DB → memory_summary.md sync
	// happens inline rather than only on next startup.
	try {
		enqueueMemoryConsolidation(stateTracker.swarmDir, workspace);
	} catch {
		// Non-critical — consolidation runs on startup independently
	}

	// Write summary
	await experienceStore.writeSummary(runId, summaryMarkdown);
	experienceStore.decayUnreferenced(referencedRunIds);

	// Archive plan
	try {
		await archivePlanForHistory(stateTracker.swarmDir, workspace);
	} catch (err) {
		logger.warn("[Curtain] Plan archival failed", { error: String(err) });
	}

	const curtainResult: CurtainResultData = {
		runId,
		status: result.status,
		totalTasks: result.taskProgress.total,
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
	activityLogger.logPhase("curtain-done", undefined, result.taskProgress.total);

	logger.info("[Curtain] Phase completed successfully");
	return curtainResult;
}

// ============================================================================
// Reporter agent — summarizes build results for the user
// ============================================================================

async function runReporterAgent(
	_workspace: string,
	result: StageResult,
	opts: {
		modelRegistry: ModelRegistry;
		settings: Settings;
		activityLogger: ActivityLogger;
		roleAssetManager?: RoleAssetManager;
		/** Elected reporter agent ID override (from ReporterElection). Falls back to "reporter". */
		reporterOverride?: string | null;
	},
	/** Optional AgentRuntime for v3 agent spawning. */
	runtime?: AgentRuntime,
): Promise<string | null> {
	const {
		modelRegistry: _modelRegistry,
		settings: _settings,
		activityLogger: _activityLogger,
		roleAssetManager,
		reporterOverride,
	} = opts;
	const reporterName = reporterOverride ?? "reporter";

	// Load reporter role
	let reporterPrompt: string | undefined;
	try {
		const role = await roleAssetManager?.get(reporterName);
		if (role?.status === "approved") {
			reporterPrompt = role.prompts.system;
		}
	} catch {
		/* use default */
	}

	const [reporterSystemPrompt, reporterTaskTemplate] = curtainReporterPrompt.split("\n---\n");
	const systemPrompt = reporterPrompt ?? prompt.render(reporterSystemPrompt, { reporterName });

	try {
		const _msgId = `curtain-${reporterName}-${Date.now()}`;
		const reportTask = prompt.render(reporterTaskTemplate, {
			status: result.status,
			completed: String(result.taskProgress.completed),
			total: String(result.taskProgress.total),
		});

		let reportOutput: string | null = null;

		// v3 path — AgentRuntime.spawn() is the only execution path.
		// Legacy streamAgentOutput() fallback removed (SP-2 convergence).
		const [handle] = await runtime!.spawn([
			{
				id: reporterName,
				role: reporterName,
				roleSource: roleAssetManager ? "library" : "inline",
				inline: !roleAssetManager ? { systemPrompt, tools: ["read", "grep", "glob"] } : undefined,
				task: reportTask,
			} as AgentSpec,
		]);

		const output = await handle.wait();
		reportOutput = output?.output ?? output ?? null;

		return reportOutput;
	} catch (err) {
		logger.warn("[Curtain] Reporter agent failed", { error: String(err) });
		return `Build completed (${result.status}). Unable to generate detailed report.`;
	}
}

// ============================================================================
// Reflection pipeline — extract + reflect + summarize
// ============================================================================

interface ReflectionResult {
	lessons: ExtractedLesson[];
	stats: LoopRunStats;
	reflectionSummary: string;
	deepReflection: DeepReflection | null;
}

async function runReflectionPipeline(
	result: StageResult,
	opts: {
		agentCount: number;
		experienceStore: ExperienceStore;
		modelRegistry: ModelRegistry;
		settings: Settings;
		runId: string;
	},
): Promise<ReflectionResult> {
	const { agentCount, experienceStore: _experienceStore, modelRegistry, settings, runId } = opts;

	// Extract lessons
	const extraction = extractLessons(result, agentCount);

	// Deep reflection (LLM, best-effort)
	let deepReflection: DeepReflection | null = null;
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
