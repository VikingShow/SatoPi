/**
 * AgentOffloadSummarizer — 通用 Agent 上下文摘要生成器
 *
 * 替代 WorkerSummarizer，不再依赖 worker/cloner 的 SingleResult。
 * 输入: AgentMessage[]（Agent 一轮对话的消息历史）
 * 输出: AgentOffloadEntry（通用摘要条目）
 *
 * 设计原则:
 * - 文本截断模式（默认）: 从 AgentMessage[] 中提取最后一条 assistant 消息的文本，截取前 200 字符
 * - LLM 模式（可选）: 将 messages 送入轻量模型生成结构化摘要，适用于输出 > 500 字符或包含 JSON 的场景
 *
 * L3 模板已知限制:
 *   当前纯模板截断（200 字符）对于工具调用输出（如 JSON blob）会产生无意义摘要。
 *   建议在输出长度 > 500 或内容以 JSON 开头时启用 LLM 模式，生成语义化摘要。
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";

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
	/** Enable LLM-based summarization for complex outputs. */
	readonly #llmEnabled: boolean;
	readonly #modelRegistry?: ModelRegistry;
	readonly #settings?: Settings;

	constructor(opts?: { llm?: { modelRegistry: ModelRegistry; settings: Settings } }) {
		this.#llmEnabled = !!opts?.llm;
		this.#modelRegistry = opts?.llm?.modelRegistry;
		this.#settings = opts?.llm?.settings;
	}

	/**
	 * 从 AgentMessage[] 生成上下文摘要。
	 *
	 * 实现策略:
	 * - 文本截断模式（默认）: 提取最后一条 assistant 消息文本，截取前 200 字符
	 * - LLM 模式（opt-in）: 当 llm 配置启用且输出 > 500 字符或含 JSON 时，使用 LLM 压缩
	 * - 如果无 assistant 消息，使用最后一条 user 消息
	 * - 有外部评分用外部评分，否则默认 5
	 * - 文本为空时 summary = "[no output]"，score = 0
	 */
	async summarize(input: AgentOffloadSummarizeInput): Promise<AgentOffloadEntry> {
		const { messages, agentId, turnIndex, phaseHint, score, taskDescription } = input;

		// 提取最后一条 assistant 消息的文本
		let outputText = "";
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === "assistant") {
				if (typeof m.content === "string") {
					outputText = m.content;
				} else if (Array.isArray(m.content)) {
					outputText = m.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map(c => c.text)
						.join("\n");
				}
				break;
			}
		}

		// Fallback: 使用最后一条 user 消息
		if (!outputText) {
			for (let i = messages.length - 1; i >= 0; i--) {
				const m = messages[i];
				if (m.role === "user") {
					if (typeof m.content === "string") {
						outputText = m.content;
					} else if (Array.isArray(m.content)) {
						outputText = m.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text)
							.join("\n");
					}
					break;
				}
			}
		}

		const trimmed = outputText.trim();
		let summary: string;
		let computedScore: number;

		if (!trimmed) {
			summary = "[no output]";
			computedScore = 0;
		} else if (this.#llmEnabled && this.#modelRegistry && this.#settings &&
			(trimmed.length > 500 || trimmed.startsWith("{") || trimmed.startsWith("["))) {
			// LLM mode: compress large or structured output
			try {
				summary = await this.#summarizeWithLLM(trimmed, agentId);
				if (!summary) throw new Error("LLM returned empty summary");
				computedScore = score ?? 5;
				logger.debug("[AgentOffloadSummarizer] LLM summarization used", { agentId, inputLen: trimmed.length, outputLen: summary.length });
			} catch (err) {
				logger.warn("[AgentOffloadSummarizer] LLM summarization failed, falling back to truncation", { error: String(err) });
				summary = trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
				computedScore = score ?? 5;
			}
		} else {
			summary = trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed;
			computedScore = score ?? 5;
		}

		// 生成任务描述
		const taskCall = taskDescription ?? phaseHint ?? `Agent turn ${turnIndex}: ${agentId}`;

		// 大型产出标记
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

	/**
	 * LLM-based summarization for complex outputs.
	 * Sends the text to a lightweight model for semantic compression.
	 */
	async #summarizeWithLLM(text: string, agentId: string): Promise<string> {
		if (!this.#modelRegistry || !this.#settings) {
			throw new Error("LLM summarization requires modelRegistry and settings");
		}

		const prompt = [
			"Summarize the following agent output in 1-2 sentences (max 200 chars).",
			"Focus on: what was accomplished, key decisions, any errors or blockers.",
			"Output ONLY the summary text, no markdown formatting.",
			"",
			`Agent: ${agentId}`,
			"---",
			text.slice(0, 3000), // Truncate input to avoid token overflow
		].join("\n");

		const result = await this.#modelRegistry.query({
			model: this.#settings.defaultModel ?? "gpt-4o-mini",
			messages: [{ role: "user", content: prompt }],
			maxTokens: 200,
		});

		const content = result?.choices?.[0]?.message?.content;
		if (!content) throw new Error("LLM returned empty response");

		return content.length > 200 ? content.slice(0, 200) + "…" : content;
	}
}
