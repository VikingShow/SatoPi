/**
 * AgentSummarizer — L1 摘要生成器
 *
 * 接收 Agent 产出的 SingleResult，生成摘要。
 *
 * 两种模式:
 * - summarize() — 同步文本截取 (≤200 字)，不调 LLM
 * - summarizeAsync() — 使用 L1LlmSummarizer (LLM 语义摘要)，需传入 modelRegistry + settings
 *   LLM 失败时自动降级到文本截取
 */

import type { SingleResult } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { L1LlmSummarizer } from "./llm-summarizer";

// ============================================================================
// Types
// ============================================================================

export interface SummarizeInput {
	/** Worker/Cloner 执行结果 */
	result: SingleResult;
	/** Agent 标识（如 "agent-1", "agent-2"） */
	agentId: string;
	/** 当前迭代编号（0-indexed） */
	iteration: number;
	/** 当前 agent 负责的 phase 名称（可选项） */
	phaseHint?: string;
	/** Cloner 评分 (0-10)，Worker 默认 5 */
	score?: number;
}

export interface SummarizeOutput {
	/** ≤200 字摘要 */
	summary: string;
	/** 0-10 质量评分 */
	score: number;
	/** 任务描述 */
	taskCall: string;
	/** artifact:// 引用（大型产出时） */
	resultRef?: string;
}

// ============================================================================
// AgentSummarizer
// ============================================================================

export class AgentSummarizer {
	readonly #llmSummarizer?: L1LlmSummarizer;

	/**
	 * @param opts.modelRegistry — ModelRegistry for LLM-based summarization (optional)
	 * @param opts.settings — Settings for LLM-based summarization (optional)
	 */
	constructor(opts?: { modelRegistry?: ModelRegistry; settings?: Settings }) {
		if (opts?.modelRegistry && opts?.settings) {
			this.#llmSummarizer = new L1LlmSummarizer(opts.modelRegistry, opts.settings);
		}
	}

	/**
	 * 生成 Agent 产出的摘要（同步，纯文本截取）。
	 *
	 * 实现策略（简单版，不调 LLM）：
	 * - 摘要截取 output 前 200 字符
	 * - 如果有 score 就用传入的，否则默认 5
	 * - 如果 output 为空 → summary = "[no output]"，score = 0
	 * - taskCall 从 phaseHint 提取，无则用 agentId
	 */
	summarize(input: SummarizeInput): SummarizeOutput {
		const { result, agentId, iteration, phaseHint, score } = input;

		// 提取摘要：截取 output 前 200 字符
		const outputText = result.output ?? result.stderr ?? "";
		const trimmed = outputText.trim();

		let summary: string;
		let computedScore: number;

		if (!trimmed) {
			summary = "[no output]";
			computedScore = 0;
		} else {
			summary = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
			computedScore = score ?? 5;
		}

		// 生成任务描述
		const taskCall = phaseHint ? `${phaseHint}` : `Agent 产出: ${agentId}`;

		// 大型产出标记
		let resultRef: string | undefined;
		if (outputText.length > 2000) {
			resultRef = `artifact://offload/${agentId}/${iteration}`;
		}

		logger.debug("[AgentSummarizer] Generated summary", {
			agentId,
			iteration,
			score: computedScore,
			summaryLen: summary.length,
			hasRef: !!resultRef,
		});

		return { summary, score: computedScore, taskCall, resultRef };
	}

	/**
	 * 生成 Agent 产出的摘要（异步，LLM 语义摘要）。
	 *
	 * 需要构造函数传入 modelRegistry + settings 才可用。
	 * LLM 失败时自动降级到 summarize() 文本截取。
	 */
	async summarizeAsync(input: SummarizeInput): Promise<SummarizeOutput> {
		const { result, agentId, iteration, phaseHint, score } = input;

		if (!this.#llmSummarizer) {
			// No LLM configured — use synchronous text fallback
			return this.summarize(input);
		}

		const outputText = result.output ?? result.stderr ?? "";
		const trimmed = outputText.trim();

		if (!trimmed) {
			return { summary: "[no output]", score: 0, taskCall: phaseHint ?? `Agent 产出: ${agentId}` };
		}

		// Try LLM-based semantic summarization
		const llmResult = await this.#llmSummarizer.summarize(trimmed);

		const taskCall = phaseHint ? `${phaseHint}` : `Agent 产出: ${agentId}`;
		let resultRef: string | undefined;
		if (outputText.length > 2000) {
			resultRef = `artifact://offload/${agentId}/${iteration}`;
		}

		logger.debug("[AgentSummarizer] Async summary generated", {
			agentId,
			iteration,
			score: llmResult.score,
			summaryLen: llmResult.summary.length,
			hasRef: !!resultRef,
		});

		return {
			summary: llmResult.summary,
			score: score ?? llmResult.score,
			taskCall,
			resultRef,
		};
	}
}
