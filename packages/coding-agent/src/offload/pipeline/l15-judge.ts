/**
 * L1.5 Task Boundary Judge — LLM-powered task lifecycle gatekeeper
 *
 * Uses oh-my-pi's LLM client for task boundary detection.
 * Inspired by TencentDB-Agent-Memory's L1.5 task judgment prompt design.
 *
 * System prompt: "You are a task lifecycle gatekeeper..."
 *
 * Temperature: 0.2, max 512 tokens.
 * Fallback: if LLM fails → safe defaults (no task boundary detected).
 */

import { type AssistantMessage, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import { resolveRoleSelection } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";

// ============================================================================
// Prompt
// ============================================================================

const L15_SYSTEM_PROMPT = [
	"You are a task lifecycle gatekeeper for an AI coding assistant. ",
	"Your job is to decide whether the current task has completed and whether ",
	"the user is starting a new task or continuing an old one.\n\n",
	"Analyze the three inputs provided:\n",
	"1. **recentMessages** — the last few conversation turns. Extract the user's ",
	'latest core intent. Is it "continue debugging", "declared complete", ',
	'"casual Q&A", or "new request"?\n',
	"2. **currentMmd** — the active Mermaid task graph. Compare the user's intent ",
	"against this graph. If the intent exceeds the graph's scope (new unrelated work) ",
	"or all nodes within scope are marked done, set taskCompleted=true.\n",
	"3. **availableMmds** — a list of historical task graphs. If the user appears to ",
	"be starting a new long task, scan this list for a match. A match means the ",
	"taskGoal is semantically similar — the user is continuing previous work.\n\n",
	"Rules:\n",
	"- taskCompleted: true when the current graph is finished or the user's intent ",
	"  is fundamentally different from the active task.\n",
	"- isLongTask: true when the user's request involves multi-step development work ",
	"  (build a feature, fix a system-wide bug, refactor). False for Q&A or trivial tweaks.\n",
	"- isContinuation: true ONLY when availableMmds contains a task whose goal closely ",
	"  matches the user's new intent.\n",
	"- continuationMmdFile: the filename of the matching historical MMD, or null.\n",
	"- newTaskLabel: a short (≤60 chars) label for the new task, or null if not starting one.\n\n",
	"Output ONLY valid JSON, no explanation or markdown:\n",
	'{"taskCompleted":bool,"isLongTask":bool,"isContinuation":bool,"continuationMmdFile":"string|null","newTaskLabel":"string|null"}',
].join("");

// ============================================================================
// Types
// ============================================================================

export interface L15Judgment {
	taskCompleted: boolean;
	isLongTask: boolean;
	isContinuation: boolean;
	continuationMmdFile: string | null;
	newTaskLabel: string | null;
}

export interface L15MmdEntry {
	filename: string;
	taskGoal: string;
	doneCount: number;
	updatedTime?: string;
}

export interface L15Input {
	recentMessages: string;
	currentMmd: string | null;
	availableMmds: L15MmdEntry[];
}

// ============================================================================
// TaskBoundaryJudge
// ============================================================================

export class TaskBoundaryJudge {
	readonly #modelRegistry: ModelRegistry;
	readonly #settings: Settings;

	constructor(modelRegistry: ModelRegistry, settings: Settings) {
		this.#modelRegistry = modelRegistry;
		this.#settings = settings;
	}

	/**
	 * Judge task boundaries: is the current task completed, is a new task starting,
	 * and is it a continuation of a previous one?
	 *
	 * On LLM failure, degrades gracefully to safe defaults (no boundary detected).
	 */
	async judge(input: L15Input): Promise<L15Judgment> {
		try {
			const model = await this.#resolveSmolModel();
			const userContent = this.#formatInput(input);

			const response = await completeSimple(
				model.model,
				{
					systemPrompt: [L15_SYSTEM_PROMPT],
					messages: [
						{
							role: "user",
							content: userContent,
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: model.apiKey,
					maxTokens: 512,
					temperature: 0.2,
					disableReasoning: true,
				},
			);

			const parsed = this.#parseResponse(response);
			if (parsed) {
				logger.debug("[TaskBoundaryJudge] LLM judgment generated", {
					taskCompleted: parsed.taskCompleted,
					isLongTask: parsed.isLongTask,
					isContinuation: parsed.isContinuation,
				});
				return parsed;
			}
			throw new Error("Failed to parse LLM response");
		} catch (err) {
			logger.warn("[TaskBoundaryJudge] LLM judgment failed, returning safe defaults", {
				error: String(err),
			});
			return this.#fallback();
		}
	}

	// -- Private helpers -------------------------------------------------------

	async #resolveSmolModel(): Promise<{ model: Model; apiKey: string }> {
		const available = this.#modelRegistry.getAvailable();
		const resolved = resolveRoleSelection(["smol"], this.#settings, available);

		if (!resolved?.model) {
			throw new Error("No smol model available for L1.5 task boundary judgment");
		}

		const apiKey = await this.#modelRegistry.getApiKey(resolved.model);
		if (!apiKey) {
			throw new Error(`No API key for ${resolved.model.provider}/${resolved.model.id}`);
		}

		return { model: resolved.model, apiKey };
	}

	#formatInput(input: L15Input): string {
		const lines: string[] = [];

		lines.push("## recentMessages");
		lines.push(input.recentMessages.slice(0, 4000));

		lines.push("\n## currentMmd");
		lines.push(input.currentMmd ?? "[none — no active task graph]");

		lines.push("\n## availableMmds");
		if (input.availableMmds.length === 0) {
			lines.push("[none]");
		} else {
			for (const mmd of input.availableMmds) {
				const updated = mmd.updatedTime ? `, updated ${mmd.updatedTime}` : "";
				lines.push(`- ${mmd.filename}: ${mmd.taskGoal} (${mmd.doneCount} done${updated})`);
			}
		}

		return lines.join("\n");
	}

	#parseResponse(response: AssistantMessage): L15Judgment | null {
		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("")
			.trim();

		if (!text) return null;

		// Extract JSON from possible markdown fences
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return null;

		try {
			const parsed = JSON.parse(jsonMatch[0]);
			if (
				typeof parsed.taskCompleted === "boolean" &&
				typeof parsed.isLongTask === "boolean" &&
				typeof parsed.isContinuation === "boolean"
			) {
				return {
					taskCompleted: parsed.taskCompleted,
					isLongTask: parsed.isLongTask,
					isContinuation: parsed.isContinuation,
					continuationMmdFile: typeof parsed.continuationMmdFile === "string" ? parsed.continuationMmdFile : null,
					newTaskLabel: typeof parsed.newTaskLabel === "string" ? parsed.newTaskLabel.slice(0, 60) : null,
				};
			}
		} catch {
			// JSON parse failed
		}

		return null;
	}

	#fallback(): L15Judgment {
		return {
			taskCompleted: false,
			isLongTask: false,
			isContinuation: false,
			continuationMmdFile: null,
			newTaskLabel: null,
		};
	}
}
