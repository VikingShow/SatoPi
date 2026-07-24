/**
 * AgentOffloadSummarizer — 通用 Agent 上下文摘要生成器
 *
 * 替代 WorkerSummarizer，不再依赖 worker/cloner 的 SingleResult。
 * 输入: AgentMessage[]（Agent 一轮对话的消息历史）
 * 输出: AgentOffloadEntry（通用摘要条目）
 *
 * 设计原则:
 * - 文本截断模式（当前实现）: 从 AgentMessage[] 中提取最后一条 assistant 消息的文本
 * - 可选 LLM 模式（未来）: 将 messages 送入轻量模型生成结构化摘要
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

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
	/**
	 * 从 AgentMessage[] 生成上下文摘要。
	 *
	 * 实现策略（简单版）:
	 * - 找到最后一条 assistant 消息，提取文本内容，截取前 200 字符
	 * - 如果无 assistant 消息，使用最后一条 user 消息
	 * - 有外部评分用外部评分，否则默认 5
	 * - 文本为空时 summary = "[no output]"，score = 0
	 */
	summarize(input: AgentOffloadSummarizeInput): AgentOffloadEntry {
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
}
