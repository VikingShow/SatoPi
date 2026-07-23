/**
 * ReviewCouncil — Cloner 圆桌审查（P0-D: 加权投票 + 否决权）。
 *
 * 每位 Cloner 可分配审查角色（guardian/adversarial/security/performance/architecture）。
 * adversarial 和 security 拥有否决权（单个 FAIL 可推翻全部 PASS）。
 * 投票按角色权重计算，不再是简单多数。
 */

import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { RoleAsset } from "./role-asset";
import type { ActivityLogger } from "./activity-logger";
import { guardTaskBudget } from "./context-guard";
import { streamAgentOutput } from "./streaming";

// ============================================================================
// Types
// ============================================================================

export interface ReviewVerdict {
	passed: boolean;
	approvalCount: number;
	totalCount: number;
	findings: string[];
	/** Cloner-suggested worker count deltas for next iteration. */
	workerCountSuggestions: number[];
	/** True when findings across cloners diverge significantly. */
	disagreed: boolean;
	/** Cloner-suggested roles for workers (Round 2+). key=workerId, value=role name. */
	roleSuggestions: Record<string, string>;
	/** Worker IDs praised by cloners this round. */
	praisedWorkers: string[];
	/** Worker IDs criticized by cloners this round. */
	criticizedWorkers: string[];
}

export interface ReviewConfig {
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
	/** P0-D: Per-cloner role assignments (clonerId → RoleAsset). When provided, each cloner gets a role-specific system prompt, weight, and veto flag. */
	clonerRoles?: Record<string, RoleAsset>;
	/** Tool restriction to apply to cloner agents (config-as-constraint). */
	toolRestriction?: import("./schema").AgentToolRestriction;
		/** Optional activity logger for SSE streaming output. */
		activityLogger?: ActivityLogger;
}

// ============================================================================
// ReviewCouncil
// ============================================================================

export class ReviewCouncil {
	/**
	 * Run a full review cycle:
	 * 1. Spawn cloner subprocesses in parallel
	 * 2. Each cloner independently reviews worker output
	 * 3. Parse JSON verdicts from cloner output
	 * 4. Tally votes — majority rule.
	 * 5. Optionally run deliberation cross-examination round.
	 */
	async review(
		config: ReviewConfig,
		modelRegistry?: ModelRegistry,
		settings?: Settings,
		signal?: AbortSignal,
	): Promise<ReviewVerdict> {
		const { clonerIds, workspace, iteration, workerOutput, planContent, previousFindings, deliberation, toolRestriction, clonerRoles, activityLogger } = config;

		// Build a cloner agent definition with optional tool restrictions applied.
		const buildClonerAgent = (id: string, i: number): AgentDefinition => {
			// P0-D: Use role-specific system prompt and tools when available.
			const role = clonerRoles?.[id];
			const def: AgentDefinition = {
				name: id,
				description: role ? `${role.name} (${role.id})` : `Cloner reviewer ${i + 1}`,
				systemPrompt: role?.prompts?.system ?? this.#clonerSystemPrompt(),
				source: "project" as const,
			};
			// P0-D: Role-specific tools take priority over config-level restrictions.
			if (role?.tools && role.tools.length > 0) {
				def.tools = role.tools;
			} else if (toolRestriction) {
				if (toolRestriction.allowed && toolRestriction.allowed.length > 0) def.tools = toolRestriction.allowed;
				if (toolRestriction.blocked && toolRestriction.blocked.length > 0) def.blockedTools = toolRestriction.blocked;
			}
			return def;
		};

		const previousFindingsBlock =
			previousFindings && previousFindings.length > 0
				? `\n## Previous Iteration Findings\n\n${previousFindings.map((f, i) => `- (Round ${i + 1}) ${f}`).join("\n")}\n\nAvoid re-flagging issues that have been addressed in subsequent iterations.`
				: "";

		const reviewPrompt = [
			`Review the output from iteration ${iteration + 1}.`,
			planContent ? `\n## Plan (what was requested)\n\n${planContent}\n` : "",
			previousFindingsBlock,
			`\n## Worker Output Summary\n\n${workerOutput}\n`,
			`\n## Instructions`,
			`- Optionally suggest \`worker_count_delta\`: signed integer adjustment to worker count (+2 to add 2, -1 to remove 1).`,
			`- After Round 1+, optionally suggest \`role_suggestions\`: {"worker-1": "implementer", "worker-2": "reviewer", ...}.`,
			`- Optionally list \`praised_workers\` and \`criticized_workers\` by worker ID.`,
			`\nReturn a single JSON line:`,
			`{"verdict":"PASS"|"FAIL","confidence":0.0-1.0,"findings":["summary of findings"],"worker_count_delta":<int>,"role_suggestions":{},"praised_workers":[],"criticized_workers":[]}`,
		];

		// Guard: token budget for cloner review (default 128K)
		const guard = guardTaskBudget(reviewPrompt, undefined, `ReviewCouncil #${iteration}`);
		if (guard.exceeded) {
			reviewPrompt.length = 0;
			reviewPrompt.push(
				`Review the output from iteration ${iteration + 1}.`,
				planContent ? `Plan: ${planContent.slice(0, 4000)}...` : "",
				`Worker Output: ${workerOutput.slice(0, 8000)}...`,
				`Return JSON: {"verdict":"PASS"|"FAIL","confidence":0.0-1.0,"findings":["..."],"worker_count_delta":0,"role_suggestions":{},"praised_workers":[],"criticized_workers":[]}`,
			);
		}

		const reviewText = reviewPrompt.join("\n");

		const settled = await Promise.allSettled(
			clonerIds.map((id, i) => {
				const clonerMsgId = `cloner-review-${id}-${iteration}`;
				return streamAgentOutput(
					{ activityLogger: activityLogger!, msgId: clonerMsgId, from: id },
					{
						cwd: workspace,
						agent: buildClonerAgent(id, i),
						task: reviewText,
						index: i,
						id: clonerMsgId,
						modelRegistry,
						settings,
						signal,
					},
				).then((r) => {
					// Emit per-cloner individual verdict for GUI channel routing
					const verdict = extractVerdict(id, r.output);
					if (verdict) {
						activityLogger?.logClonerIndividual(id, verdict.passed, verdict.findings);
					}
					return r;
				});
			}),
		);
		const results: SingleResult[] = settled.map((s, i) => {
			if (s.status === "fulfilled") return s.value;
			const errMsg = s.reason instanceof Error ? s.reason.message : String(s.reason);
			return {
				index: i,
				id: `cloner-review-${clonerIds[i]}-${iteration}`,
				agent: clonerIds[i],
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

		const firstVerdict = tallyVerdicts(results, clonerRoles);

		// Deliberation: if FAIL + findings diverge + deliberation enabled, run cross-examination
		if (!firstVerdict.passed && firstVerdict.disagreed && deliberation) {
			const findingsSummary = firstVerdict.findings.map((f, i) => `${i + 1}. ${f}`).join("\n");

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
				`{"verdict":"PASS"|"FAIL","confidence":0.0-1.0,"findings":["your final findings"],"worker_count_delta":<int>,"role_suggestions":{},"praised_workers":[],"criticized_workers":[]}`,
			].join("\n");

			const deliberationSettled = await Promise.allSettled(
				clonerIds.map((id, i) => {
					const delibMsgId = `cloner-deliberation-${id}-${iteration}`;
					return streamAgentOutput(
						{ activityLogger: activityLogger!, msgId: delibMsgId, from: id },
						{
							cwd: workspace,
							agent: buildClonerAgent(id, i),
							task: deliberationPrompt,
							index: i,
							id: delibMsgId,
							modelRegistry,
							settings,
							signal,
						},
					);
				}),
			);
			const deliberationResults: SingleResult[] = deliberationSettled.map((s, i) => {
				if (s.status === "fulfilled") return s.value;
				const errMsg = s.reason instanceof Error ? s.reason.message : String(s.reason);
				return {
					index: i,
					id: `cloner-deliberation-${clonerIds[i]}-${iteration}`,
					agent: clonerIds[i],
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

			return tallyVerdicts(deliberationResults, clonerRoles);
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
	/** Cloner's suggested worker count delta for the next iteration (signed integer). */
	workerCountDelta?: number;
	/** Cloner's role assignment for each worker. key=workerId, value=role name. */
	roleSuggestions?: Record<string, string>;
	/** Worker IDs the cloner praised. */
	praisedWorkers?: string[];
	/** Worker IDs the cloner criticized. */
	criticizedWorkers?: string[];
}
/**
 * Extract the first balanced JSON object containing a "verdict" key.
 * Uses bracket-depth tracking to handle nested objects and braces
 * inside string values — more robust than a flat regex.
 */
function extractVerdictJson(text: string): Record<string, unknown> | null {
	let pos = 0;
	while (true) {
		const start = text.indexOf("{", pos);
		if (start === -1) return null;
		let depth = 0;
		let inString = false;
		let escape = false;
		for (let i = start; i < text.length; i++) {
			const ch = text[i];
			if (escape) { escape = false; continue; }
			if (ch === "\\") { escape = true; continue; }
			if (ch === '"') { inString = !inString; continue; }
			if (inString) continue;
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) {
					const candidate = text.slice(start, i + 1);
					try {
						const parsed = JSON.parse(candidate);
						if (parsed && typeof parsed === "object" && "verdict" in parsed) {
							return parsed as Record<string, unknown>;
						}
					} catch {
						// Not valid JSON or no verdict key — keep searching
					}
					break; // move to next `{`
				}
			}
		}
		pos = start + 1;
	}
}

export function extractVerdict(_reviewerId: string, text: string): ParsedVerdict | null {
	// Try JSON first — use balanced bracket extraction for robustness
	const parsed = extractVerdictJson(text) as {
		verdict: string;
		confidence: number;
		findings: string | string[];
		worker_count?: number;
		worker_count_delta?: number;
		role_suggestions?: Record<string, string>;
		praised_workers?: string[];
		criticized_workers?: string[];
	} | null;
	if (parsed) {
		try {
			const findingsArr = Array.isArray(parsed.findings) ? parsed.findings : [parsed.findings ?? ""];
			// worker_count_delta takes precedence; fall back to legacy worker_count
			const delta =
				typeof parsed.worker_count_delta === "number"
					? parsed.worker_count_delta
					: typeof parsed.worker_count === "number"
						? parsed.worker_count - 3 // legacy: approximate delta from absolute count
						: undefined;
			return {
				passed: parsed.verdict === "PASS",
				findings: findingsArr,
				confidence: parsed.confidence ?? 0.5,
				workerCountDelta: delta,
				roleSuggestions: parsed.role_suggestions,
				praisedWorkers: parsed.praised_workers,
				criticizedWorkers: parsed.criticized_workers,
			};
		} catch {
			// fall through to heuristic
		}
	}

	// Heuristic: FAIL keywords without PASS
	const hasFail = /\b(?:FAIL|REJECT)/i.test(text) && !/\bPASS/i.test(text);
	if (hasFail) {
		return {
			passed: false,
			findings: [`${_reviewerId}: ${text.slice(0, 200)}`],
			confidence: 0.5,
		};
	}

	// Heuristic: PASS keyword present
	const hasPass = /\bPASS\b/i.test(text);
	if (hasPass) {
		return {
			passed: true,
			findings: [],
			confidence: 0.5,
		};
	}

	return null;
}

export function tallyVerdicts(results: SingleResult[], clonerRoles?: Record<string, RoleAsset>): ReviewVerdict {
	const findings: string[] = [];
	const workerCounts: number[] = [];
	let approvalCount = 0;
	let totalCount = 0;
	let weightedPass = 0;
	let weightedTotal = 0;
	const allRoleSuggestions: Record<string, string> = {};
	const praisedWorkers = new Set<string>();
	const criticizedWorkers = new Set<string>();
	// P0-D: Veto tracking.
	let vetoFail = false;
	const vetoCloners: string[] = [];

	for (const result of results) {
		if (result.output.startsWith("[CRASHED]")) continue;
		totalCount++;
		const verdict = extractVerdict(result.agent, result.output);
		if (verdict) {
			findings.push(...verdict.findings.map(f => `[${result.agent}] ${f}`));
			if (verdict.passed) approvalCount++;

			// P0-D: Weighted voting when roles are assigned.
			const role = clonerRoles?.[result.agent];
			const weight = role?.weight ?? 1.0;
			weightedTotal += weight;
			if (verdict.passed) weightedPass += weight;
			// Veto: adversarial or security FAIL → override.
			if (!verdict.passed && role?.veto) {
				vetoFail = true;
				vetoCloners.push(`${result.agent}(${role.id})`);
			}

			if (verdict.workerCountDelta !== undefined) workerCounts.push(verdict.workerCountDelta);
			if (verdict.roleSuggestions) Object.assign(allRoleSuggestions, verdict.roleSuggestions);
			if (verdict.praisedWorkers) for (const w of verdict.praisedWorkers) praisedWorkers.add(w);
			if (verdict.criticizedWorkers) for (const w of verdict.criticizedWorkers) criticizedWorkers.add(w);
		}
	}

	// When all cloner subprocesses crashed, totalCount is 0. This is a
	// systemic failure (not normal FAIL), so surface it explicitly so the
	// LoopController can escalate rather than silently retrying.
	if (totalCount === 0) {
		return {
			passed: false,
			approvalCount: 0,
			totalCount: 0,
			findings: ["[SYSTEM] All cloner subprocesses failed — no review available"],
			workerCountSuggestions: [],
			disagreed: false,
			roleSuggestions: {},
			praisedWorkers: [],
			criticizedWorkers: [],
		};
	}

	// P0-D: Veto overrides weighted majority.
	const simplePassed = totalCount > 0 && approvalCount >= Math.ceil(totalCount / 2);
	const weightedPassed = weightedTotal > 0 && weightedPass / weightedTotal > 0.5;
	const passed = vetoFail ? false : (clonerRoles ? weightedPassed : simplePassed);

	const disagreed =
		!passed &&
		findings.length > 1 &&
		new Set(findings.map(f => f.replace(/^\[.*?\]\s*/, ""))).size >= Math.ceil(totalCount / 2);

	return {
		passed,
		approvalCount,
		totalCount,
		findings: vetoFail
			? [...findings, `[VETO] FAIL forced by: ${vetoCloners.join(", ")} — verdict overridden to FAIL`]
			: findings,
		workerCountSuggestions: workerCounts,
		disagreed: vetoFail || disagreed,
		roleSuggestions: allRoleSuggestions,
		praisedWorkers: [...praisedWorkers],
		criticizedWorkers: [...criticizedWorkers],
	};
}
