/**
 * ClonerRoundtable — 多轮 Cloner 计划辩论。
 *
 * After Socrates produces a draft plan.md, 2-3 cloner instances debate it
 * over multiple rounds. Each cloner independently critiques the plan, then
 * cloners see each other's critiques and refine their positions. The roundtable
 * converges when plan text similarity (Jaccard) stabilizes for N consecutive
 * rounds, or when max rounds is reached.
 *
 * Reuses the convergence patterns from loop-controller.ts (jaccardSimilarity,
 * findingsSimilarity).
 */

import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { logger } from "@oh-my-pi/pi-utils";

// ============================================================================
// Types
// ============================================================================

export interface DebateRound {
	/** Round number (1-indexed). */
	round: number;
	/** Cloner outputs for this round. */
	outputs: string[];
	/** Jaccard similarity vs previous round (null for round 1). */
	similarity: number | null;
}

export interface ClonerRoundtableConfig {
	/** Number of cloner instances in the debate. */
	clonerCount: number;
	/** Maximum debate rounds. */
	maxRounds: number;
	/**
	 * Number of consecutive rounds with similarity >= threshold to declare
	 * convergence. Default: 2.
	 */
	convergenceThreshold: number;
}

export interface ClonerRoundtableResult {
	/** Whether the debate converged. */
	converged: boolean;
	/** The final refined plan text. */
	refinedPlan: string;
	/** All debate rounds (for debugging/transparency). */
	rounds: DebateRound[];
	/** The draft plan that was debated. */
	draftPlan: string;
}

// ============================================================================
// Similarity
// ============================================================================

function jaccardSimilarity(a: string[], b: string[]): number {
	const setA = new Set(a);
	const setB = new Set(b);
	if (setA.size === 0 && setB.size === 0) return 1;
	const intersection = new Set([...setA].filter(x => setB.has(x)));
	return intersection.size / (setA.size + setB.size - intersection.size);
}

function textSimilarity(a: string, b: string): number {
	const tokenize = (text: string): string[] =>
		text
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(t => t.length > 2);
	return jaccardSimilarity(tokenize(a), tokenize(b));
}

// ============================================================================
// ClonerRoundtable
// ============================================================================

export class ClonerRoundtable {
	readonly #config: Required<ClonerRoundtableConfig>;

	constructor(config: ClonerRoundtableConfig) {
		this.#config = {
			clonerCount: config.clonerCount,
			maxRounds: config.maxRounds,
			convergenceThreshold: config.convergenceThreshold,
		};
	}

	/**
	 * Run the plan debate.
	 *
	 * @param draftPlan — the current plan.md content (from Socrates)
	 * @param workspace — absolute workspace path
	 */
	async debate(
		draftPlan: string,
		workspace: string,
		modelRegistry?: ModelRegistry,
		settings?: Settings,
		signal?: AbortSignal,
	): Promise<ClonerRoundtableResult> {
		const { clonerCount, maxRounds, convergenceThreshold } = this.#config;
		const rounds: DebateRound[] = [];
		let previousOutputs: string[] = [];
		let convergenceStreak = 0;
		let lastRoundOutputs: string[] = [];

		for (let round = 1; round <= maxRounds; round++) {
			if (signal?.aborted) break;

			const isFirstRound = round === 1;
			const roundPrompt = isFirstRound
				? this.#buildRound1Prompt(draftPlan)
				: this.#buildRefinePrompt(draftPlan, previousOutputs);

			// Spawn cloners in parallel for this round
			const settled = await Promise.allSettled(
				Array.from({ length: clonerCount }, (_, i) =>
					runSubprocess({
						cwd: workspace,
						agent: {
							name: `debate-cloner-${i + 1}`,
							description: `Plan debate cloner ${i + 1}`,
							systemPrompt: this.#debateClonerSystemPrompt(),
							source: "project",
						},
						task: roundPrompt,
						index: i,
						id: `plan-debate-r${round}-c${i + 1}`,
						modelRegistry,
						settings,
						signal,
					}),
				),
			);
			const results: SingleResult[] = settled.map((s, i) => {
				if (s.status === "fulfilled") return s.value;
				const errMsg = s.reason instanceof Error ? s.reason.message : String(s.reason);
				return {
					index: i,
					id: `plan-debate-r${round}-c${i + 1}`,
					agent: `debate-cloner-${i + 1}`,
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

			const outputs = results.map(r => this.#extractPlanContent(r));
			const similarity =
				lastRoundOutputs.length > 0 ? this.#computeRoundSimilarity(lastRoundOutputs, outputs) : null;

			rounds.push({ round, outputs, similarity });
			logger.debug("ClonerRoundtable round completed", {
				round,
				similarity,
				outputLengths: outputs.map(o => o.length),
			});

			// Convergence detection
			if (similarity !== null && similarity >= 0.85) {
				convergenceStreak++;
				if (convergenceStreak >= convergenceThreshold) {
					logger.info("ClonerRoundtable converged", {
						round,
						similarity,
						convergenceStreak,
					});
					return {
						converged: true,
						refinedPlan: this.#synthesizeFinalPlan(outputs),
						rounds,
						draftPlan,
					};
				}
			} else {
				convergenceStreak = 0;
			}

			previousOutputs = outputs;
			lastRoundOutputs = outputs;
		}

		// Max rounds reached — synthesize final plan from last round
		const finalOutputs = rounds[rounds.length - 1]?.outputs ?? [draftPlan];
		return {
			converged: false,
			refinedPlan: this.#synthesizeFinalPlan(finalOutputs),
			rounds,
			draftPlan,
		};
	}

	// ============================================================================
	// Private helpers
	// ============================================================================

	#debateClonerSystemPrompt(): string {
		return [
			`You are a Cloner in the Loop Engineering system — a peer discussant`,
			`who participates in plan debates to refine task plans before execution.`,
			``,
			`Your role in this debate:`,
			`- Read the plan critically. Your interpretation may differ from others — state it clearly.`,
			`- Challenge assumptions, flag gaps, identify unclear acceptance criteria.`,
			`- When peers raise valid points, acknowledge them and refine your position.`,
			`- The goal is to produce the strongest possible plan, not to "win".`,
			``,
			`Output your refined plan as markdown. End with a brief summary of`,
			`key changes you made and why.`,
		].join("\n");
	}

	#buildRound1Prompt(plan: string): string {
		return [
			`# Plan Debate — Round 1`,
			``,
			`You are participating in a plan debate. Below is a draft plan.`,
			`Your task:`,
			``,
			`1. **Critique the plan.** Identify:`,
			`   - Gaps: missing requirements, edge cases, underspecified deliverables`,
			`   - Contradictions: conflicting constraints or goals`,
			`   - Ambiguity: unclear acceptance criteria, vague scope boundaries`,
			`   - Risky assumptions: where the plan assumes knowledge or behavior that is not guaranteed`,
			`2. **Produce a refined plan.** Rewrite the plan incorporating your critique.`,
			`   Preserve the original intent but strengthen clarity and completeness.`,
			``,
			`Output format: your refined plan as markdown, then a "## Key Changes" section`,
			`summarizing what you changed and why.`,
			``,
			`## Draft Plan`,
			``,
			plan,
		].join("\n");
	}

	#buildRefinePrompt(plan: string, peerOutputs: string[]): string {
		const peerSummary = peerOutputs
			.map((o, i) => `### Cloner ${i + 1}\n\n${this.#truncateOutput(o)}`)
			.join("\n\n---\n\n");

		return [
			`# Plan Debate — Refinement Round`,
			``,
			`Your peers have produced the following plan critiques and refinements.`,
			`Read them carefully. Consider their points — they may see gaps you missed.`,
			``,
			`Your task:`,
			``,
			`1. **Synthesize.** Merge the best insights from all critiques into a`,
			`   single stronger plan. Address points raised by peers.`,
			`2. **Disagree constructively.** If you believe a peer's suggestion is wrong,`,
			`   explain why in your "Key Changes" section, but still produce your best plan.`,
			`3. **Produce a refined plan.** The final output should be a complete,`,
			`   executable plan that incorporates the strongest ideas from this round.`,
			``,
			`## Original Draft Plan`,
			``,
			plan,
			``,
			`## Peer Critiques from Previous Round`,
			``,
			peerSummary,
		].join("\n");
	}

	#extractPlanContent(result: SingleResult): string {
		// The cloner should output markdown directly — strip any JSON/chat framing
		const output = result.output.trim();
		// Skip crashed cloners — return empty so they don't pollute the debate
		if (output.startsWith("[CRASHED]")) return "";
		// Try to strip a leading JSON verdict line
		const jsonLineEnd = output.indexOf("\n");
		if (jsonLineEnd > 0 && output.startsWith("{")) {
			const rest = output.slice(jsonLineEnd + 1).trim();
			return rest.length > 100 ? rest : output;
		}
		return output;
	}

	#truncateOutput(output: string, maxLength = 3000): string {
		if (output.length <= maxLength) return output;
		return `${output.slice(0, maxLength)}\n\n[... truncated ...]`;
	}

	#computeRoundSimilarity(prevOutputs: string[], currOutputs: string[]): number {
		// Average pairwise similarity between rounds
		let total = 0;
		let count = 0;
		const n = Math.max(prevOutputs.length, currOutputs.length);
		for (let i = 0; i < n; i++) {
			const prev = prevOutputs[Math.min(i, prevOutputs.length - 1)] ?? "";
			const curr = currOutputs[Math.min(i, currOutputs.length - 1)] ?? "";
			if (prev || curr) {
				total += textSimilarity(prev, curr);
				count++;
			}
		}
		return count > 0 ? total / count : 0;
	}

	/**
	 * Synthesize final plan by picking the most detailed output from the last round,
	 * preferring longer output as a signal of thorough refinement.
	 */
	#synthesizeFinalPlan(outputs: string[]): string {
		const valid = outputs.filter(o => o.length > 0);
		if (valid.length === 0) return "";
		// Pick the longest output as the most thorough
		let best = valid[0];
		for (let i = 1; i < valid.length; i++) {
			if (valid[i].length > best.length) best = valid[i];
		}
		return best;
	}
}
