/**
 * BeforeLoop — Loop 启动前的规划对话。
 *
 * 流程:
 *   1. /loopeng 触发 → Cloner 分析任务
 *   2. Cloner ↔ Human 多轮对话 (Socratic 引导)
 *   3. Cloner 产出 plan.md (无固定模板) + worker/cloner 数量提案
 *   4. Human 确认 → Loop 启动
 *
 * 集成方式:
 *   扩展命令 handler 调用 generatePlanningPrompt() 获得提示文本，
 *   注入 agent 对话流中。Human 回复后，Cloner 自然引导至 plan.md 产出。
 *   当 plan.md 就绪 + human 确认 → handler 执行实际循环。
 */

import type { LoopSwarmConfig } from "./schema";
import { ExperienceStore } from "./after-loop/experience";
import * as path from "node:path";

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
 * Stamp plan.md with a generation timestamp if not already stamped.
 * Returns the content with the timestamp prepended, or unchanged if already stamped.
 */
export async function stampPlanMd(workspace: string): Promise<string> {
	const planPath = path.join(workspace, ".omp", "plan.md");
	const content = await Bun.file(planPath).text();
	if (content.startsWith("<!-- plan-generated:")) return content;
	const stamp = `<!-- plan-generated: ${new Date().toISOString()} -->\n`;
	const stamped = stamp + content;
	await Bun.write(planPath, stamped);
	return stamped;
}
