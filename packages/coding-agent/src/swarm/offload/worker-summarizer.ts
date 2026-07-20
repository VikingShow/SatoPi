/**
 * WorkerSummarizer — L1 摘要生成器
 *
 * 接收 Worker/Cloner 产出的 SingleResult，用文本截取生成 ≤200 字摘要。
 * 不调用 LLM（简单实现），摘要直接取 output 前 200 字符。
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent";

// ============================================================================
// Types
// ============================================================================

export interface SummarizeInput {
	/** Worker/Cloner 执行结果 */
	result: SingleResult;
	/** Agent 标识（如 "worker-1", "cloner-2"） */
	agentId: string;
	/** Agent 类型 */
	agentType: "worker" | "cloner" | "orchestrator";
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
// WorkerSummarizer
// ============================================================================

export class WorkerSummarizer {
	/**
	 * 生成 Worker/Cloner 产出的摘要。
	 *
	 * 实现策略（简单版，不调 LLM）：
	 * - 摘要截取 output 前 200 字符
	 * - 如果有 Cloner score 就用 Cloner 的，否则默认 5
	 * - 如果 output 为空 → summary = "[no output]"，score = 0
	 * - agentType="cloner" 时 taskCall = "审查: {agentId}"
	 * - agentType="worker" 时 taskCall 从 phaseHint 提取
	 */
	summarize(input: SummarizeInput): SummarizeOutput {
		const { result, agentId, agentType, iteration, phaseHint, score } = input;

		// 提取摘要：截取 output 前 200 字符
		const outputText = result.output ?? result.stderr ?? "";
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
		let taskCall: string;
		switch (agentType) {
			case "cloner":
				taskCall = `审查: ${agentId}`;
				break;
			case "orchestrator":
				taskCall = `编排决策 (iter ${iteration})`;
				break;
			case "worker":
			default:
				taskCall = phaseHint ? `${phaseHint}` : `Worker 产出: ${agentId}`;
				break;
		}

		// 大型产出标记
		let resultRef: string | undefined;
		if (outputText.length > 2000) {
			resultRef = `artifact://offload/${agentId}/${iteration}`;
		}

		logger.debug("[WorkerSummarizer] Generated summary", {
			agentId,
			agentType,
			iteration,
			score: computedScore,
			summaryLen: summary.length,
			hasRef: !!resultRef,
		});

		return { summary, score: computedScore, taskCall, resultRef };
	}
}
