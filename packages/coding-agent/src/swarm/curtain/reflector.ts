/**
 * After Loop — LLM Deep Reflection.
 *
 * Takes the completed LoopResult + extracted lessons and performs a single
 * cheap-model LLM call to identify root causes, effective patterns,
 * structural issues, and actionable recommendations.
 *
 * Stored as a `type: "reflection"` lesson in the experience store.
 */

import { type AssistantMessage, completeSimple } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";

import type { ModelRegistry } from "../../config/model-registry";
import { resolveRoleSelection } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import reflectionSystemPrompt from "../../prompts/system/loop-reflection.md" with { type: "text" };
import type { LoopResult } from "../loop-controller";
import type { ExtractedLesson, ExtractionResult } from "./extractor";

// ============================================================================
// Types
// ============================================================================

/** Structured output from the deep reflection LLM call. */
export interface DeepReflection {
	/** Systemic reasons the loop succeeded or failed. */
	rootCauses: string[];
	/** Coordination or review patterns that worked well. */
	effectivePatterns: string[];
	/** Recurring problems in task decomposition, review, or convergence. */
	structuralIssues: string[];
	/** Concrete, actionable changes for future loop runs. */
	recommendations: string[];
	/** LLM self-assessed confidence (0–1). */
	confidence: number;
}

// ============================================================================
// Constants
// ============================================================================

const REFLECTION_MODEL_ROLES = ["tiny", "smol"] as const;
const REFLECTION_MAX_TOKENS = 1024;

// ============================================================================
// Reflector
// ============================================================================

/**
 * Perform a deep LLM reflection on a completed loop run.
 *
 * Uses a cheap (smol/tiny) model to analyze the loop's outcome, extracted
 * lessons, and agent review. Returns structured insights for storage in
 * the experience database.
 *
 * @returns DeepReflection on success, or `null` if the LLM call fails
 *   (timeout, no model available, unparseable output). Failures are logged
 *   but never throw — reflection is best-effort.
 */
export async function reflectDeep(
	result: LoopResult,
	extraction: ExtractionResult,
	deps: {
		registry: ModelRegistry;
		settings: Settings;
		sessionId?: string;
		signal?: AbortSignal;
	},
): Promise<DeepReflection | null> {
	// Resolve a cheap model
	const resolved = resolveRoleSelection(REFLECTION_MODEL_ROLES, deps.settings, deps.registry.getAvailable());
	const model = resolved?.model;
	if (!model) {
		logger.warn("reflectDeep: no smol/tiny model available for reflection");
		return null;
	}

	const apiKey = await deps.registry.getApiKey(model, deps.sessionId);
	if (!apiKey) {
		logger.warn("reflectDeep: no API key for reflection model", {
			provider: model.provider,
			model: model.id,
		});
		return null;
	}

	// Build the reflection prompt from loop data
	const userPrompt = buildReflectionPrompt(result, extraction);

	let response: AssistantMessage;
	try {
		response = await completeSimple(
			model,
			{
				systemPrompt: [prompt.render(reflectionSystemPrompt)],
				messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
			},
			{
				apiKey: deps.registry.resolver(model, deps.sessionId),
				maxTokens: REFLECTION_MAX_TOKENS,
				disableReasoning: true,
				signal: deps.signal,
			},
		);
	} catch (err) {
		logger.warn("reflectDeep: LLM call failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}

	if (response.stopReason === "error") {
		logger.warn("reflectDeep: LLM returned error", {
			errorMessage: response.errorMessage,
		});
		return null;
	}
	if (response.stopReason === "aborted") {
		logger.warn("reflectDeep: LLM call aborted");
		return null;
	}

	// Extract text content
	const text = extractTextContent(response);
	if (!text) {
		logger.warn("reflectDeep: LLM returned no text content");
		return null;
	}

	// Parse JSON from response
	const parsed = parseReflectionJson(text);
	if (!parsed) {
		logger.warn("reflectDeep: could not parse reflection JSON", { text: text.slice(0, 200) });
		return null;
	}

	return parsed;
}

// ============================================================================
// Build reflection lesson for storage
// ============================================================================

/**
 * Convert a DeepReflection into an ExtractedLesson suitable for storage.
 */
export function reflectionToLesson(reflection: DeepReflection, runId: string): ExtractedLesson {
	const summaryParts: string[] = [];
	if (reflection.rootCauses.length > 0) {
		summaryParts.push(`Root causes: ${reflection.rootCauses.slice(0, 2).join("; ")}`);
	}
	if (reflection.recommendations.length > 0) {
		summaryParts.push(`Recommendations: ${reflection.recommendations.slice(0, 2).join("; ")}`);
	}

	const detail = [
		"## Root Causes",
		...reflection.rootCauses.map(c => `- ${c}`),
		"",
		"## Effective Patterns",
		...reflection.effectivePatterns.map(p => `- ${p}`),
		"",
		"## Structural Issues",
		...reflection.structuralIssues.map(i => `- ${i}`),
		"",
		"## Recommendations",
		...reflection.recommendations.map(r => `- ${r}`),
	].join("\n");

	return {
		type: "reflection",
		summary: summaryParts.join(" | ") || `Deep reflection for ${runId}`,
		detail,
		tags: ["reflection", "deep-analysis", "after-loop"],
		confidence: reflection.confidence,
		source: "reflector-llm",
	};
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build the user-facing part of the reflection prompt from the loop result
 * and extracted lessons.
 */
function buildReflectionPrompt(result: LoopResult, extraction: ExtractionResult): string {
	const { stats, lessons } = extraction;

	const lines: string[] = [
		"## Loop Run Summary",
		"",
		`- Status: ${result.status}`,
		`- Iterations: ${result.iterations}`,
		`- Workers: ${stats.agentCount}`,
		`- Agents: ${stats.agentCount}`,
		`- Cloner approval ratio: ${stats.reviewApprovalRatio}`,
	];

	if (result.errors.length > 0) {
		lines.push("", "### Errors", ...result.errors.map(e => `- ${e.slice(0, 300)}`));
	}

	// Review findings
	const findings = result.reviewVerdicts.flatMap(v => v.findings);
	if (findings.length > 0) {
		lines.push("", "### Review Findings", ...findings.slice(0, 10).map(f => `- ${f.slice(0, 300)}`));
	}

	// Extracted lessons
	if (lessons.length > 0) {
		lines.push("", "### Extracted Lessons");
		for (const lesson of lessons) {
			lines.push(
				`- [${lesson.type}] ${lesson.summary.slice(0, 200)}`,
				`  Tags: ${lesson.tags.join(", ")}`,
				`  Confidence: ${lesson.confidence}`,
			);
		}
	}

	return lines.join("\n");
}

/**
 * Extract text content from an assistant message.
 * Handles both plain text and multimodal content arrays.
 */
function extractTextContent(msg: AssistantMessage): string | null {
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return (
			msg.content
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map(b => b.text)
				.join("\n") || null
		);
	}
	return null;
}

/**
 * Parse a JSON reflection from LLM output text.
 * Handles code-fenced JSON, raw JSON, and markdown-wrapped JSON.
 */
function parseReflectionJson(text: string): DeepReflection | null {
	// Try raw parse first
	try {
		return validateReflection(JSON.parse(text));
	} catch {
		// continue
	}

	// Try extracting from code fences (```json ... ``` or ``` ... ```)
	const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fenceMatch) {
		try {
			return validateReflection(JSON.parse(fenceMatch[1]));
		} catch {
			// continue
		}
	}

	// Try finding a JSON object anywhere in the text
	const objectMatch = text.match(/\{[\s\S]*"root_causes"[\s\S]*\}/);
	if (objectMatch) {
		try {
			return validateReflection(JSON.parse(objectMatch[0]));
		} catch {
			// continue
		}
	}

	return null;
}

/**
 * Validate and normalize a parsed reflection object.
 */
function validateReflection(obj: unknown): DeepReflection | null {
	if (!obj || typeof obj !== "object") return null;
	const o = obj as Record<string, unknown>;

	const rootCauses = Array.isArray(o.root_causes)
		? o.root_causes.filter((c): c is string => typeof c === "string")
		: [];
	const effectivePatterns = Array.isArray(o.effective_patterns)
		? o.effective_patterns.filter((p): p is string => typeof p === "string")
		: [];
	const structuralIssues = Array.isArray(o.structural_issues)
		? o.structural_issues.filter((i): i is string => typeof i === "string")
		: [];
	const recommendations = Array.isArray(o.recommendations)
		? o.recommendations.filter((r): r is string => typeof r === "string")
		: [];

	let confidence = typeof o.confidence === "number" ? o.confidence : 0.5;
	confidence = Math.max(0, Math.min(1, confidence));

	return { rootCauses, effectivePatterns, structuralIssues, recommendations, confidence };
}
