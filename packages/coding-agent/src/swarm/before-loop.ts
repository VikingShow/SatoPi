/**
 * BeforeLoop — Loop 启动前的规划与辩论。
 *
 * 流程:
 *   1. /loopeng 触发 → Socrates 苏格拉底式对话
 *   2. Socrates ↔ Human 多轮对话 (Socratic 引导)
 *   3. Socrates 产出 draft plan.md
 *   4. (NEW) Cloner Roundtable 多轮辩论草案 → refined plan.md
 *   5. Human 确认 → Loop 启动
 *
 * 集成方式:
 *   扩展命令 handler 调用 generatePlanningPrompt() 获得提示文本，
 *   注入 agent 对话流中。Human 回复后，Socrates 自然引导至 plan.md 产出。
 *   当 plan.md 就绪 → runPlanDebate() → human 确认 → handler 执行实际循环。
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExperienceStore } from "./after-loop/experience";
import type { LoopSwarmConfig } from "./schema";

// ============================================================================
// Types
// ============================================================================

export interface BeforeLoopConfig {
	workspace: string;
	loopConfig: LoopSwarmConfig;
	/** The task description from the human's initial message. */
	taskDescription?: string;
}

export interface BeforeLoopResult {
	/** Whether to proceed with the loop. */
	confirmed: boolean;
	/** Path to the generated plan.md. */
	planPath: string | null;
	/** Proposed worker count. */
	proposedWorkerCount: number;
	/** Proposed cloner count. */
	proposedClonerCount: number;
	/** Additional context for the loop. */
	context: Record<string, unknown>;
}

// ============================================================================
// Prompt Generation
// ============================================================================

/**
 * Generate the Before Loop planning prompt for the Cloner.
 *
 * This prompt is injected into the conversation when /loopeng triggers.
 * The Cloner receives it and engages the human in a Socratic dialogue
 * to clarify goals, constraints, and acceptance criteria.
 *
 * After sufficient clarification, the Cloner produces:
 *   - .omp/plan.md — the task plan
 * @param experienceStore Optional store to query past loop experience.
 */
export async function generatePlanningPrompt(
	config: BeforeLoopConfig,
	experienceStore?: ExperienceStore,
): Promise<string> {
	const { workspace, loopConfig, taskDescription } = config;

	const defaultWorkers = loopConfig.workers.initial;
	const defaultCloners = loopConfig.cloners.count;

	const sections = [
		"# Before Loop — Planning Phase",
		"",
		"You are now in the **Before Loop** planning phase. Your goal is to understand",
		"what the human wants to achieve, then produce a clear plan that the Loop Engineering",
		"system can execute.",
		"",
		"## Process",
		"",
		"1. **Understand the task** — Ask clarifying questions. Understand goals, constraints,",
		"   acceptance criteria, and any preferences the human has.",
		"2. **Produce plan.md** — Once you have sufficient clarity, write the plan to",
		`   \`${workspace}/.omp/plan.md\`. Use any format that captures:`,
		"   - What to build/achieve",
		"   - Constraints and non-goals",
		"   - Acceptance criteria (how to verify success)",
		"   - Suggested approach (optional)",
		"3. **Propose worker/cloner counts** — Based on task complexity, propose how many",
		`   workers and cloners to use. Default: ${defaultWorkers} workers, ${defaultCloners} cloners.`,
		"   - More workers for parallelizable tasks",
		"   - More cloners for safety-critical tasks",
		"4. **Ask for confirmation** — Present the plan and count proposal.",
		"   The human can confirm (/loopeng start), modify, or cancel.",
		"",
		"## Guidelines",
		"",
		"- Be concise but thorough — understand before planning.",
		"- The plan.md format is YOUR choice — don't force a rigid template.",
		"- Default worker/cloner counts are usually fine; only adjust with good reason.",
		"- Workers are blank agents who self-organize via group chat. They need:",
		"  - Clear acceptance criteria",
		"  - Any constraints (e.g. 'use Bun APIs, not Node')",
		"  - Scope boundaries (what NOT to touch)",
		"- Past plans are archived at `.omp/plans/`. Review them to understand iteration history.",
		"- If the human gives insufficient information, ASK. Don't guess critical details.",
		"",
		"## When Ready",
		"",
		"When the human confirms, respond with a brief summary and tell them:",
		`'Type /loopeng start to begin Loop Engineering with N workers and M cloners.'`,
	];

	if (taskDescription) {
		sections.push("");
		sections.push("## Current Task Context");
		sections.push("");
		sections.push(taskDescription);
	}

	// Query past experience if store is available
	if (experienceStore && taskDescription) {
		const lessons = experienceStore.search(taskDescription, 5);
		if (lessons.length > 0) {
			// Mark referenced lessons to boost their weight (experience decay feedback)
			experienceStore.markReferenced(lessons.map(l => l.runId));

			sections.push("");
			sections.push("## Relevant Past Experience");
			sections.push("");
			sections.push("The following lessons were learned from previous Loop Engineering runs.");
			sections.push("Use them to avoid known pitfalls and apply successful patterns.");
			sections.push("");
			for (const result of lessons) {
				const l = result.lesson;
				sections.push(`- [${l.type}] ${l.summary}`);
				sections.push(`  Source: ${l.source} (rank: ${result.rank.toFixed(1)})`);
			}
		}
	}

	return sections.join("\n");
}
export async function planExists(workspace: string): Promise<boolean> {
	return Bun.file(path.join(workspace, ".omp", "plan.md")).exists();
}

/**
 * Stamp plan.md with a generation timestamp and return the stamped content.
 *
 * If the plan is already stamped (from a previous run), archives it first.
 * If unstamped (fresh Cloner output), stamps it.
 *
 * NOTE: Archive of old content only works when called BEFORE the Cloner
 * overwrites plan.md. In the current flow (called at loop start, after
 * Cloner has already written), the archive path only fires if the Cloner
 * did NOT overwrite — i.e., a re-run of an already-stamped plan.
 * Fresh plans from the Cloner are always unstamped, so archiving old content
 * happens via archivePlanForHistory() called at the END of each run instead.
 */
export async function stampAndArchivePlanMd(workspace: string): Promise<string> {
	const planPath = path.join(workspace, ".omp", "plan.md");
	const content = await Bun.file(planPath).text();

	if (content.startsWith("<!-- plan-generated:")) {
		// Plan is already stamped (re-run without Cloner overwrite).
		// Archive it before returning — the caller may allow a Cloner to rewrite it.
		const archiveDir = path.join(workspace, ".omp", "plans");
		const ts = new Date().toISOString().replace(/:/g, "").slice(0, 19);
		const archivePath = path.join(archiveDir, `plan-${ts}.md`);
		await Bun.write(archivePath, content);
		return content;
	}

	// New unstamped plan → stamp it.
	const stamp = `<!-- plan-generated: ${new Date().toISOString()} -->\n`;
	const stamped = stamp + content;
	await Bun.write(planPath, stamped);
	return stamped;
}

/**
 * Archive the current plan.md to .omp/plans/ for historical reference.
 *
 * Called at the END of a loop run, this saves the plan that was just
 * executed. The stamp comment is stripped so archived plans contain
 * only the original plan content (without generation timestamp).
 *
 * This MUST be called before the next Cloner run overwrites plan.md.
 */
export async function archivePlanForHistory(workspace: string): Promise<void> {
	const planPath = path.join(workspace, ".omp", "plan.md");

	let content: string;
	try {
		content = await Bun.file(planPath).text();
	} catch {
		return; // No plan to archive
	}

	if (content.trim().length === 0) return;

	// Strip stamp comment if present — archived plans are raw plan content.
	if (content.startsWith("<!-- plan-generated:")) {
		const nl = content.indexOf("\n");
		content = nl >= 0 ? content.slice(nl + 1) : "";
	}

	const archiveDir = path.join(workspace, ".omp", "plans");
	const ts = new Date().toISOString().replace(/:/g, "").slice(0, 19);
	const archivePath = path.join(archiveDir, `plan-${ts}.md`);
	await Bun.write(archivePath, content);
}

/**
 * List archived plans in reverse chronological order (newest first).
 * Returns absolute paths to each archived plan file.
 */
export async function listArchivedPlans(workspace: string): Promise<string[]> {
	const archiveDir = path.join(workspace, ".omp", "plans");
	try {
		const entries = await fs.readdir(archiveDir);
		return entries
			.filter(e => e.startsWith("plan-") && e.endsWith(".md"))
			.sort()
			.reverse()
			.map(e => path.join(archiveDir, e));
	} catch {
		return [];
	}
}

// ============================================================================
// Plan Debate (Cloner Roundtable)
// ============================================================================

import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import { ClonerRoundtable } from "./cloner-roundtable";

export interface PlanDebateResult {
	/** Whether the debate produced a refined plan. */
	refined: boolean;
	/** The final plan text (may be unchanged if debate was skipped). */
	planContent: string;
	/** Whether convergence was achieved. */
	converged: boolean;
}

/**
 * Run the plan debate phase: 2-3 cloner instances debate the draft plan.md
 * over multiple rounds to produce a stronger plan before execution.
 *
 * Called after Socrates produces a draft plan.md but BEFORE human confirmation.
 * If plan_debate.enabled is false, returns the draft plan unchanged.
 *
 * @param draftPlan — the current plan.md content
 * @param workspace — absolute workspace path
 * @param loopConfig — the loop configuration
 */
export async function runPlanDebate(
	draftPlan: string,
	workspace: string,
	loopConfig: LoopSwarmConfig,
	modelRegistry?: ModelRegistry,
	settings?: Settings,
	signal?: AbortSignal,
): Promise<PlanDebateResult> {
	const debateConfig = loopConfig.planDebate;
	if (!debateConfig.enabled) {
		logger.debug("Plan debate disabled, using draft plan as-is");
		return { refined: false, planContent: draftPlan, converged: false };
	}

	const table = new ClonerRoundtable({
		clonerCount: debateConfig.clonerCount,
		maxRounds: debateConfig.maxRounds,
		convergenceThreshold: debateConfig.convergenceThreshold,
	});

	logger.info("Starting plan debate", {
		clonerCount: debateConfig.clonerCount,
		maxRounds: debateConfig.maxRounds,
		convergenceThreshold: debateConfig.convergenceThreshold,
	});

	const result = await table.debate(draftPlan, workspace, modelRegistry, settings, signal);

	// Write the refined plan back to disk
	const planPath = path.join(workspace, ".omp", "plan.md");
	await Bun.write(planPath, result.refinedPlan);

	logger.info("Plan debate completed", {
		converged: result.converged,
		rounds: result.rounds.length,
		originalLength: draftPlan.length,
		refinedLength: result.refinedPlan.length,
	});

	return {
		refined: true,
		planContent: result.refinedPlan,
		converged: result.converged,
	};
}
