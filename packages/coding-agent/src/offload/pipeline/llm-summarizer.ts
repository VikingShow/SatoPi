/**
 * L1LlmSummarizer — LLM-powered semantic summarizer (L1)
 *
 * Uses oh-my-pi's LLM client for structured semantic summarization,
 * inspired by TencentDB-Agent-Memory's L1 summarization prompt design.
 *
 * Prompt: "You are a concise summarizer. Given a tool call result, produce:
 *   1. A one-sentence summary (≤150 chars)
 *   2. A replaceability score (0-10): how well this summary can replace the original
 *      (10 = perfect replacement, 0 = summary loses critical detail)
 * Return JSON: { summary: string, score: number }"
 *
 * Temperature: 0.2, max 256 tokens.
 * Fallback: if LLM fails, degrade to text slicing (first 200 chars).
 */

import { completeSimple, type AssistantMessage, type Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { resolveRoleSelection } from "../../config/model-resolver"
import type { ModelRegistry } from "../../config/model-registry"
import type { Settings } from "../../config/settings"

// ============================================================================
// Prompt
// ============================================================================

const L1_SYSTEM_PROMPT = [
	"You are a concise summarizer for an AI coding assistant. Given a tool call ",
	"result or agent output, produce a high-density structured summary.\n\n",
	"Rules:\n",
	"1. Identify the key action, finding, or decision in the text.\n",
	"2. Write exactly one sentence (≤150 characters) that captures the essential ",
	"business value — what was accomplished, discovered, or blocked.\n",
	"3. Assign a replaceability score (0-10):\n",
	"   10 = this summary perfectly replaces the original (dense, lossless).\n",
	"    5 = summary captures the gist but misses some nuance.\n",
	"    0 = summary is nearly useless; critical detail was lost.\n",
	"   Prefer score 7-9 for good summaries; reserve 10 for truly lossless compression.\n\n",
	"Output ONLY valid JSON, no explanation or markdown:\n",
	'{ "summary": "string ≤150 chars", "score": number }',
].join("");

// ============================================================================
// Types
// ============================================================================

export interface L1Summary {
	/** One-sentence semantic summary (≤150 chars) */
	summary: string;
	/** Replaceability score 0-10 */
	score: number;
}

// ============================================================================
// L1LlmSummarizer
// ============================================================================

export class L1LlmSummarizer {
	readonly #modelRegistry: ModelRegistry;
	readonly #settings: Settings;

	constructor(modelRegistry: ModelRegistry, settings: Settings) {
		this.#modelRegistry = modelRegistry;
		this.#settings = settings;
	}

	/**
	 * Generate a semantic summary of the given text using a lightweight LLM.
	 *
	 * On LLM failure, degrades gracefully to text slicing (first 200 chars, score 3).
	 */
	async summarize(text: string): Promise<L1Summary> {
		const trimmed = text.trim();
		if (!trimmed) {
			return { summary: "[no output]", score: 0 };
		}

		// Try LLM-based summarization
		try {
			const model = await this.#resolveSmolModel();
			const response = await completeSimple(
				model.model,
				{
					systemPrompt: [L1_SYSTEM_PROMPT],
					messages: [
						{
							role: "user",
							content: `Summarize this tool/agent output:\n\n${trimmed.slice(0, 2000)}`,
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: model.apiKey,
					maxTokens: 256,
					temperature: 0.2,
					disableReasoning: true,
				},
			);

			const parsed = this.#parseResponse(response);
			if (parsed) {
				logger.debug("[L1LlmSummarizer] LLM summary generated", {
					inputLen: trimmed.length,
					summaryLen: parsed.summary.length,
					score: parsed.score,
				});
				return parsed;
			}
			throw new Error("Failed to parse LLM response");
		} catch (err) {
			logger.warn("[L1LlmSummarizer] LLM summarization failed, falling back to text slicing", {
				error: String(err),
			});
			return this.#fallbackSlice(trimmed);
		}
	}

	// -- Private helpers -------------------------------------------------------

	async #resolveSmolModel(): Promise<{ model: Model; apiKey: string }> {
		const available = this.#modelRegistry.getAvailable();
		const resolved = resolveRoleSelection(["smol"], this.#settings, available);

		if (!resolved?.model) {
			throw new Error("No smol model available for L1 summarization");
		}

		const apiKey = await this.#modelRegistry.getApiKey(resolved.model);
		if (!apiKey) {
			throw new Error(`No API key for ${resolved.model.provider}/${resolved.model.id}`);
		}

		return { model: resolved.model, apiKey };
	}

	#parseResponse(response: AssistantMessage): L1Summary | null {
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
				typeof parsed.summary === "string" &&
				typeof parsed.score === "number" &&
				parsed.score >= 0 &&
				parsed.score <= 10
			) {
				return {
					summary: parsed.summary.slice(0, 200),
					score: Math.round(parsed.score),
				};
			}
		} catch {
			// JSON parse failed
		}

		return null;
	}

	#fallbackSlice(text: string): L1Summary {
		return {
			summary: text.length > 200 ? text.slice(0, 200) + "…" : text,
			score: 3,
		};
	}
}
