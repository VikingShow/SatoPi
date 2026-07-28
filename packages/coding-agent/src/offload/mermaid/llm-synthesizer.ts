/**
 * LlmMermaidSynthesizer — LLM-powered Mermaid flowchart TD generator (L2)
 *
 * Uses oh-my-pi's LLM client for semantic Mermaid generation from tool-call
 * records, inspired by TencentDB-Agent-Memory's L2 graph synthesis prompt.
 *
 * System prompt: "You are a pragmatic AI task topology architect.
 * Map tool-call records into a semantic Mermaid flowchart TD.
 *
 * Elastic aggregation: merge consecutive similar actions into macro nodes.
 * Cognitive tombstones: mark dead ends as status:blocked with warning.
 * Node format: NodeID["phase: summary<br/>status: done|doing|blocked<br/>summary: …<br/>Timestamp: ISO8601"]
 *
 * Output ONLY valid JSON with file_action, mmd_content, replace_blocks, node_mapping."
 *
 * Temperature: 0.2, max 512 tokens.
 * Fallback: if LLM fails, generate a simple template-based MMD.
 */

import { type AssistantMessage, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import { resolveRoleSelection } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";

// ============================================================================
// Prompt
// ============================================================================

const L2_SYSTEM_PROMPT = [
	"You are a pragmatic AI task topology architect. Map tool-call records ",
	"into a semantic Mermaid flowchart TD.\n\n",
	"Rules:\n",
	"1. Elastic aggregation: merge consecutive similar actions into macro nodes. ",
	"Keep the graph at a macro level — group related tool calls into a single ",
	"phase node when they serve the same goal.\n",
	"2. Cognitive tombstones: when a tool call leads to a dead end (error, ",
	"abandoned approach, blocked path), mark it as `status:blocked` with a ",
	'warning summary like "[BLOCKED] reason".\n',
	"3. Node format — use this exact Mermaid node shape:\n",
	'   NodeID["phase: <label><br/>status: done|doing|blocked<br/>summary: <core conclusion ≤150 chars><br/>Timestamp: <ISO8601>"]\n',
	"4. Edges: `N1 --> N2` for sequential flow; `N1 -.-> N2` for planned / ",
	"tentative transitions; `N1 --x N2` for blocked / abandoned paths.\n",
	"5. The graph must start with a `Start` node and end with the latest ",
	"or current state node.\n\n",
	"Output ONLY valid JSON, no explanation or markdown fences around the JSON:\n",
	"{\n",
	'  "file_action": "replace" | "write",\n',
	'  "mmd_content": "full MMD wrapped in ```mermaid...``` (when write) or null (when replace)",\n',
	'  "replace_blocks": [{ "start_line": N, "end_line": M, "content": "mermaid lines (no fences, no backticks)" }],\n',
	'  "node_mapping": { "tool_call_id": "N1", ... }\n',
	"}",
].join("");

// ============================================================================
// Types
// ============================================================================

export interface L2NewEntry {
	toolCallId: string;
	toolCall: string;
	summary: string;
	timestamp: string;
}

export interface L2ReplaceBlock {
	/** 1-based start line in existing MMD */
	startLine: number;
	/** 1-based end line in existing MMD (inclusive) */
	endLine: number;
	/** replacement Mermaid lines (no ```fences```, no backticks) */
	content: string;
}

export interface L2MermaidOutput {
	/** Whether to write a new file or patch existing lines */
	fileAction: "write" | "replace";
	/** Full MMD content when fileAction is "write" (wrapped in ```mermaid...```) */
	mmdContent: string | null;
	/** Line-level patches when fileAction is "replace" */
	replaceBlocks: L2ReplaceBlock[];
	/** Maps tool_call_id → node_id for traceability */
	nodeMapping: Record<string, string>;
}

interface L2SynthesizeInput {
	/** Current MMD content (with line numbers if replace mode is desired) */
	existingMmd: string | null;
	/** New offload entries to map into the graph */
	entries: L2NewEntry[];
	/** Task label (used as graph metadata) */
	taskLabel: string;
}

// ============================================================================
// LlmMermaidSynthesizer
// ============================================================================

export class LlmMermaidSynthesizer {
	readonly #modelRegistry?: ModelRegistry;
	readonly #settings?: Settings;

	constructor(modelRegistry?: ModelRegistry, settings?: Settings) {
		this.#modelRegistry = modelRegistry;
		this.#settings = settings;
	}

	/**
	 * Generate or update a semantic Mermaid flowchart TD from tool-call
	 * records using a lightweight LLM.
	 *
	 * On LLM failure, degrades gracefully to a simple template-based MMD.
	 */
	async synthesize(input: L2SynthesizeInput): Promise<L2MermaidOutput> {
		const { existingMmd, entries, taskLabel } = input;

		if (!entries || entries.length === 0) {
			return this.#emptyOutput(existingMmd);
		}

		// Try LLM-based synthesis
		try {
			const model = await this.#resolveSmolModel();
			const response = await completeSimple(
				model.model,
				{
					systemPrompt: [L2_SYSTEM_PROMPT],
					messages: [
						{
							role: "user",
							content: this.#buildUserPrompt(existingMmd, entries, taskLabel),
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
				logger.debug("[LlmMermaidSynthesizer] LLM MMD generated", {
					fileAction: parsed.fileAction,
					entries: entries.length,
					nodes: Object.keys(parsed.nodeMapping).length,
				});
				return parsed;
			}
			throw new Error("Failed to parse LLM response");
		} catch (err) {
			logger.warn("[LlmMermaidSynthesizer] LLM synthesis failed, falling back to template", { error: String(err) });
			return this.#fallbackTemplate(existingMmd, entries, taskLabel);
		}
	}

	// -- Private helpers -------------------------------------------------------

	async #resolveSmolModel(): Promise<{ model: Model; apiKey: string }> {
		if (!this.#modelRegistry || !this.#settings) {
			throw new Error("ModelRegistry and Settings required for L2 Mermaid synthesis");
		}

		const available = this.#modelRegistry.getAvailable();
		const resolved = resolveRoleSelection(["smol"], this.#settings, available);

		if (!resolved?.model) {
			throw new Error("No smol model available for L2 Mermaid synthesis");
		}

		const apiKey = await this.#modelRegistry.getApiKey(resolved.model);
		if (!apiKey) {
			throw new Error(`No API key for ${resolved.model.provider}/${resolved.model.id}`);
		}

		return { model: resolved.model, apiKey };
	}

	#buildUserPrompt(existingMmd: string | null, entries: L2NewEntry[], taskLabel: string): string {
		const lines: string[] = [];

		lines.push(`Task Label: ${taskLabel}`);
		lines.push("");

		if (existingMmd) {
			lines.push("--- Existing MMD ---");
			lines.push(existingMmd);
			lines.push("");
			lines.push("--- New Offload Entries ---");
		} else {
			lines.push("--- Offload Entries (no existing MMD) ---");
		}

		for (const entry of entries) {
			lines.push(`[tool_call_id: ${entry.toolCallId}]`);
			lines.push(`  timestamp: ${entry.timestamp}`);
			lines.push(`  tool: ${entry.toolCall}`);
			lines.push(`  summary: ${entry.summary || "[no summary]"}`);
			lines.push("");
		}

		lines.push(
			existingMmd
				? "Generate replace_blocks to patch the existing MMD with new nodes/edges, keeping existing structure. Map each tool_call_id to its node."
				: "Generate a complete MMD file. Map each tool_call_id to its node.",
		);

		return lines.join("\n");
	}

	#parseResponse(response: AssistantMessage): L2MermaidOutput | null {
		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("")
			.trim();

		if (!text) return null;

		// Extract JSON from possible markdown fences (defensive)
		const jsonMatch = text.match(/\{[\s\S]*\}/);
		if (!jsonMatch) return null;

		try {
			const raw = JSON.parse(jsonMatch[0]);

			// Validate shape
			const fileAction = raw.file_action ?? raw.fileAction;
			if (fileAction !== "write" && fileAction !== "replace") return null;

			return {
				fileAction,
				mmdContent: fileAction === "write" ? (raw.mmd_content ?? raw.mmdContent ?? null) : null,
				replaceBlocks:
					fileAction === "replace"
						? this.#normalizeReplaceBlocks(raw.replace_blocks ?? raw.replaceBlocks ?? [])
						: [],
				nodeMapping: raw.node_mapping ?? raw.nodeMapping ?? {},
			};
		} catch {
			// JSON parse failed
		}

		return null;
	}

	#normalizeReplaceBlocks(raw: unknown[]): L2ReplaceBlock[] {
		if (!Array.isArray(raw)) return [];
		return raw
			.filter((b): b is Record<string, unknown> => typeof b === "object" && b !== null)
			.map(b => ({
				startLine: Number(b.start_line ?? b.startLine) || 0,
				endLine: Number(b.end_line ?? b.endLine) || 0,
				content: String(b.content ?? ""),
			}))
			.filter(b => b.startLine > 0 && b.endLine >= b.startLine);
	}

	#emptyOutput(existingMmd: string | null): L2MermaidOutput {
		return {
			fileAction: existingMmd ? "replace" : "write",
			mmdContent: existingMmd ? null : "```mermaid\nflowchart TD\n  Start[Start]\n  End[End]\n  Start --> End\n```",
			replaceBlocks: [],
			nodeMapping: {},
		};
	}

	/**
	 * Fallback: template-based MMD generation when LLM is unavailable.
	 * Produces a simple linear flowchart with one node per entry.
	 */
	#fallbackTemplate(existingMmd: string | null, entries: L2NewEntry[], taskLabel: string): L2MermaidOutput {
		const nodeMapping: Record<string, string> = {};
		const nodeLines: string[] = [];
		const edgeLines: string[] = [];

		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			const nodeId = `N${i + 1}`;
			nodeMapping[entry.toolCallId] = nodeId;

			const summary = (entry.summary || "entry").slice(0, 150);
			const escapedSummary = summary.replace(/"/g, "'").replace(/\n/g, " ");
			const escapedTool = entry.toolCall.replace(/"/g, "'");

			nodeLines.push(
				`  ${nodeId}["${escapedTool}<br/>summary: ${escapedSummary}<br/>Timestamp: ${entry.timestamp}"]`,
			);
		}

		// Linear edges
		for (let i = 1; i < entries.length; i++) {
			edgeLines.push(`  N${i} --> N${i + 1}`);
		}

		const title = `  title [${taskLabel.replace(/"/g, "'")}]`;
		const mmdBody = [
			"flowchart TD",
			title,
			"  Start[Start]",
			...nodeLines,
			"  End[End]",
			`  Start --> N1`,
			...edgeLines,
			...(entries.length > 0 ? [`  N${entries.length} --> End`] : ["  Start --> End"]),
		].join("\n");

		const mmdContent = `\`\`\`mermaid\n${mmdBody}\n\`\`\``;

		if (!existingMmd) {
			return {
				fileAction: "write",
				mmdContent,
				replaceBlocks: [],
				nodeMapping,
			};
		}

		// When existing MMD exists, try replace mode — replace the last edge
		// before End with the new nodes and edges
		const newBlock = [...nodeLines, ...edgeLines].join("\n");
		return {
			fileAction: "replace",
			mmdContent: null,
			replaceBlocks: [
				{
					startLine: 1,
					endLine: 1,
					content: newBlock,
				},
			],
			nodeMapping,
		};
	}
}
