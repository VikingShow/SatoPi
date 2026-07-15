/**
 * ClonerCouncil — Cloner 圆桌审查。
 *
 * 每位 Cloner 独立审查 worker 产出，按多维度评估后投票。
 * 多数通过 → PASS；否则 FAIL（附带全部 findings 反馈给 workers）。
 *
 * 无 atropos_veto 特殊角色 —— 所有 Cloner 平等，一人一票。
 */

import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { WorkerChannel } from "./worker-channel";

// ============================================================================
// Types
// ============================================================================

export interface ReviewVerdict {
	passed: boolean;
	approvalCount: number;
	totalCount: number;
	findings: string[];
	/** Cloner-suggested worker counts for next iteration. */
	workerCountSuggestions: number[];
	/** True when findings across cloners diverge significantly. */
	disagreed: boolean;
}

export interface ClonerReviewConfig {
	/** Cloner agent IDs. */
	clonerIds: string[];
	/** Workspace directory. */
	workspace: string;
	/** Iteration number (0-indexed). */
	iteration: number;
	/** Worker output text for review context. */
	workerOutput: string;
	/** plan.md content from Before Loop. Cloners review against this. */
	planContent?: string;
	/** Findings from previous iterations. Cloners avoid re-flagging resolved issues. */
	previousFindings?: string[];
	/** Enable cross-examination round when findings diverge. Default false. */
	deliberation?: boolean;
}

// ============================================================================
// ClonerCouncil
// ============================================================================

export class ClonerCouncil {
	readonly #channel: WorkerChannel;

	constructor(channel: WorkerChannel) {
		this.#channel = channel;
	}

	/**
	 * Run a full review cycle:
	 * 1. Spawn cloner subprocesses in parallel
	 * 2. Each cloner independently reviews worker output
	 * 3. Parse JSON verdicts from cloner output
	 * 4. Tally votes — majority rule.
	 * 5. Optionally run deliberation cross-examination round.
	 */
	async review(
		config: ClonerReviewConfig,
		modelRegistry?: ModelRegistry,
		settings?: Settings,
		signal?: AbortSignal,
	): Promise<ReviewVerdict> {
		const { clonerIds, workspace, iteration, workerOutput, planContent, previousFindings, deliberation } = config;

		const previousFindingsBlock = previousFindings && previousFindings.length > 0
			? `\n## Previous Iteration Findings\n\n${previousFindings.map((f, i) => `- (Round ${i + 1}) ${f}`).join("\n")}\n\nAvoid re-flagging issues that have been addressed in subsequent iterations.`
			: "";

		const reviewPrompt = [
			`Review the output from iteration ${iteration + 1}.`,
			planContent ? `\n## Plan (what was requested)\n\n${planContent}\n` : "",
			previousFindingsBlock,
			`\n## Worker Output Summary\n\n${workerOutput}\n`,
			`\n## Instructions`,
			`- The workspace at \`${workspace}\` contains the actual files produced by workers.`,
			`- Read and inspect those files directly — the summary above is for orientation only.`,
			`- Evaluate against the plan's goals, constraints, and acceptance criteria.`,
			`- Consider these dimensions:`,
			`  - Alignment: Does the output match the plan's goals?`,
			`  - Quality: Is the code/documentation quality acceptable?`,
			`  - Safety: Are there security vulnerabilities or dangerous patterns?`,
			`  - Completeness: How much of the acceptance criteria is covered?`,
			`- Optionally suggest \`worker_count\`: the ideal number of workers for the next iteration (integer).`,
			`\nReturn a single JSON line:`,
			`{"verdict":"PASS"|"FAIL","confidence":0.0-1.0,"findings":["summary of findings"],"worker_count":<number>}`,
		].join("\n");

		const results = await Promise.all(
			clonerIds.map((id, i) =>
				runSubprocess({
					cwd: workspace,
					agent: {
						name: id,
						description: `Cloner reviewer ${i + 1}`,
						systemPrompt: this.#clonerSystemPrompt(),
						source: "project",
					},
					task: reviewPrompt,
					index: i,
					id: `cloner-review-${id}-${iteration}`,
					modelRegistry,
					settings,
					signal,
				}),
			),
		);

		const firstVerdict = tallyVerdicts(results);

		// Deliberation: if FAIL + findings diverge + deliberation enabled, run cross-examination
		if (!firstVerdict.passed && firstVerdict.disagreed && deliberation) {
			const findingsSummary = firstVerdict.findings
				.map((f, i) => `${i + 1}. ${f}`)
				.join("\n");

			const deliberationPrompt = [
				`Your initial review resulted in a FAIL with split findings.`,
				`Re-evaluate after examining your peers' perspectives:`,
				``,
				`## All Cloner Findings (cross-examination round)`,
				findingsSummary,
				``,
				`## Instructions`,
				`- Re-read the workspace files at \`${workspace}\`.`,
				`- Consider whether your peers raised valid concerns you missed, or whether their concerns are unfounded.`,
				`- Adjust your verdict if persuaded; otherwise, stand your ground.`,
				planContent ? `- Measure against the plan's goals: ${planContent.slice(0, 200)}` : "",
				`\nReturn a single JSON line:`,
				`{"verdict":"PASS"|"FAIL","confidence":0.0-1.0,"findings":["your final findings"],"worker_count":<number>}`,
			].join("\n");

			const deliberationResults = await Promise.all(
				clonerIds.map((id, i) =>
					runSubprocess({
						cwd: workspace,
						agent: {
							name: id,
							description: `Cloner reviewer ${i + 1}`,
							systemPrompt: this.#clonerSystemPrompt(),
							source: "project",
						},
						task: deliberationPrompt,
						index: i,
						id: `cloner-deliberation-${id}-${iteration}`,
						modelRegistry,
						settings,
						signal,
					}),
				),
			);

			return tallyVerdicts(deliberationResults);
		}

		return firstVerdict;
	}

	#clonerSystemPrompt(): string {
		return [
			`You are a Cloner in the Loop Engineering system.`,
			`You are a clone of the agent that spoke with the human —`,
			`you carry the human's intent and know exactly what they want.`,
			``,
			`Review worker output against the plan's goals, constraints, and acceptance criteria.`,
			`The plan is included in your task prompt.`,
			`Inspect the actual workspace files — do not rely solely on the worker output summary.`,
			`Consider alignment, quality, safety, and completeness.`,
			`Output ONLY a JSON verdict line — no other commentary.`,
		].join("\n");
	}
}

// ============================================================================
// Helpers
// ============================================================================

interface ParsedVerdict {
	passed: boolean;
	findings: string[];
	confidence: number;
	/** Cloner's suggested worker count for the next iteration. */
	workerCount?: number;
}

/**
 * Parse a JSON verdict from cloner output.
 * Falls back to heuristic keyword detection if JSON parse fails.
 */
export function extractVerdict(reviewerId: string, text: string): ParsedVerdict | null {
	// Try JSON first
	const jsonMatch = text.match(/\{[^}]*"verdict"[^}]*\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]) as {
				verdict: string;
				confidence: number;
				findings: string | string[];
				worker_count?: number;
			};
			const findingsArr = Array.isArray(parsed.findings)
				? parsed.findings
				: [parsed.findings ?? ""];
			return {
				passed: parsed.verdict === "PASS",
				findings: findingsArr,
				confidence: parsed.confidence ?? 0.5,
				workerCount: typeof parsed.worker_count === "number" ? parsed.worker_count : undefined,
			};
		} catch {
			// fall through to heuristic
		}
	}

	// Heuristic: FAIL keywords without PASS.
	const hasFail = /\b(?:FAIL|REJECT)/i.test(text) && !/\bPASS/i.test(text);
	if (hasFail) {
		return {
			passed: false,
			findings: [`${reviewerId}: ${text.slice(0, 200)}`],
			confidence: 0.5,
		};
	}

	return null;
}

export function tallyVerdicts(results: SingleResult[]): ReviewVerdict {
	const findings: string[] = [];
	const workerCounts: number[] = [];
	let approvalCount = 0;
	let totalCount = 0;

	for (const result of results) {
		totalCount++;
		const verdict = extractVerdict(result.agent, result.output);
		if (verdict) {
			findings.push(...verdict.findings.map((f) => `[${result.agent}] ${f}`));
			if (verdict.passed) approvalCount++;
			if (verdict.workerCount !== undefined) workerCounts.push(verdict.workerCount);
		}
	}

	const passed = totalCount > 0 && approvalCount >= Math.ceil(totalCount / 2);
	// Findings diverge when each cloner reports different findings
	const disagreed = !passed && findings.length > 1 && new Set(findings.map((f) => f.replace(/^\[.*?\]\s*/, ""))).size >= Math.ceil(totalCount / 2);

	return { passed, approvalCount, totalCount, findings, workerCountSuggestions: workerCounts, disagreed };
}
