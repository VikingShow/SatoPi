/**
 * AgentOffloadSummarizer — 通用 Agent 上下文摘要生成器
 *
 * 替代 WorkerSummarizer，不再依赖 worker/cloner 的 SingleResult。
 * 输入: AgentMessage[]（Agent 一轮对话的消息历史）
 * 输出: AgentOffloadEntry（通用摘要条目）
 *
 * 设计原则:
 * - LLM 模式（默认）: 将 messages 送入轻量模型生成语义化摘要
 * - 文本截断模式（降级）: LLM 失败时自动降级为截取前 200 字符
 * - 无 modelRegistry 配置时，纯文本截断
 *
 * L3 模板已知限制:
 *   当前纯模板截断（200 字符）对于工具调用输出（如 JSON blob）会产生无意义摘要。
 *   默认启用 LLM 模式生成语义化摘要，失败时自动降级到文本截取。
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { L1LlmSummarizer } from "./llm-summarizer"
import type { ModelRegistry } from "../../config/model-registry"
import type { Settings } from "../../config/settings"

// ============================================================================
// Types
// ============================================================================

export interface AgentOffloadSummarizeInput {
	/** Agent 一轮对话的完整消息历史 */
	messages: AgentMessage[];
	/** Agent 标识 */
	agentId: string;
	/** 当前 turn index (0-indexed) */
	turnIndex: number;
	/** 当前 agent 负责的 phase 名称（可选） */
	phaseHint?: string;
	/** 外部质量评分 (0-10)，默认 5 */
	score?: number;
	/** 任务描述（替代 worker/cloner 的 task 字段） */
	taskDescription?: string;
}

export interface AgentOffloadEntry {
	/** Agent 标识 */
	agentId: string;
	/** ≤200 字摘要 */
	summary: string;
	/** 0-10 质量评分 */
	score: number;
	/** 任务描述 */
	taskCall: string;
	/** 当前 turn index */
	turnIndex: number;
	/** phase 名称（可选） */
	phaseHint?: string;
	/** artifact:// 引用（大型产出时） */
	resultRef?: string;
	/** 时间戳 */
	timestamp: string;
}

// ============================================================================
// AgentOffloadSummarizer
// ============================================================================

export class AgentOffloadSummarizer {
	readonly #llmSummarizer?: L1LlmSummarizer;

	/**
	 * @param opts.modelRegistry — ModelRegistry for LLM-based summarization
	 * @param opts.settings — Settings for LLM-based summarization
	 *
	 * When modelRegistry + settings are provided, LLM mode is enabled.
	 * When omitted, falls back to text truncation only.
	 */
	constructor(opts?: { modelRegistry?: ModelRegistry; settings?: Settings }) {
		if (opts?.modelRegistry && opts?.settings) {
			this.#llmSummarizer = new L1LlmSummarizer(opts.modelRegistry, opts.settings);
		}
	}

	/**
	 * Generate a context summary from AgentMessage[].
	 *
	 * Strategy:
	 * - LLM mode (default, needs modelRegistry + settings): use lightweight LLM
	 * - Text fallback: LLM failure degrades to 200-char truncation
	 * - No LLM config: pure text truncation
	 * - Falls back to last user message when no assistant message exists
	 * - Uses external score when provided, defaults to 5
	 * - Empty output → summary = "[no output]", score = 0
	 */
	async summarize(input: AgentOffloadSummarizeInput): Promise<AgentOffloadEntry> {
		const { messages, agentId, turnIndex, phaseHint, score, taskDescription } = input;

		const outputText = this.#extractLastMessageText(messages);
		const trimmed = outputText.trim();
		let summary: string;
		let computedScore: number;

		if (!trimmed) {
			summary = "[no output]";
			computedScore = 0;
		} else if (this.#llmSummarizer) {
			try {
				const llmResult = await this.#llmSummarizer.summarize(trimmed);
				summary = llmResult.summary;
				computedScore = score ?? llmResult.score;
				logger.debug("[AgentOffloadSummarizer] LLM summarization used", {
					agentId,
					inputLen: trimmed.length,
					outputLen: summary.length,
					score: computedScore,
				});
			} catch (err) {
				logger.warn("[AgentOffloadSummarizer] LLM summarization failed, falling back to truncation", { error: String(err) });
				summary = trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
				computedScore = score ?? 5;
			}
		} else {
			summary = trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
			computedScore = score ?? 5;
		}

		const taskCall = taskDescription ?? phaseHint ?? `Agent turn ${turnIndex}: ${agentId}`;

		let resultRef: string | undefined;
		if (outputText.length > 2000) {
			resultRef = `artifact://offload/${agentId}/${turnIndex}`;
		}

		logger.debug("[AgentOffloadSummarizer] Generated summary", {
			agentId,
			turnIndex,
			score: computedScore,
			summaryLen: summary.length,
			hasRef: !!resultRef,
		});

		return {
			agentId,
			summary,
			score: computedScore,
			taskCall,
			turnIndex,
			phaseHint,
			resultRef,
			timestamp: new Date().toISOString(),
		};
	}

	// -- Private helpers -------------------------------------------------------

	#extractLastMessageText(messages: AgentMessage[]): string {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === "assistant") {
				const text = this.#messageToText(m);
				if (text) return text;
				break;
			}
		}

		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === "user") {
				const text = this.#messageToText(m);
				if (text) return text;
				break;
			}
		}

		return "";
	}

	#messageToText(m: AgentMessage): string {
		if (typeof m.content === "string") {
			return m.content;
		}
		if (Array.isArray(m.content)) {
			return m.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("\n");
		}
		return "";
	}
}
