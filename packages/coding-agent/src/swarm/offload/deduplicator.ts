/**
 * Deduplicator — L1.5 去重 + 任务边界检测
 *
 * 对 L1 WorkerSummarizer 产生的摘要条目进行去重，
 * 过滤噪声（低分条目），并根据 Cloner ReviewVerdict 检测任务边界。
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { ReviewVerdict } from "../pipeline";

// ============================================================================
// Types
// ============================================================================

export interface DedupEntry {
	agentId: string;
	summary: string;
	score: number;
	iteration: number;
}

export interface DedupInput {
	/** L1 产出的待去重条目 */
	entries: DedupEntry[];
	/** 上一轮 L1.5 已处理的条目（用于跨迭代去重） */
	prevEntries?: DedupEntry[];
	/** Cloner 审查结果（用于边界检测） */
	verdict?: ReviewVerdict;
}

export type TaskBoundary =
	| { type: "none" }
	| { type: "completed"; reason: string }
	| { type: "blocked"; reason: string }
	| { type: "converged"; reason: string };

export interface DedupOutput {
	/** 去重后保留的条目 */
	kept: DedupEntry[];
	/** 被移除的 agentId 列表 */
	removed: string[];
	/** 移除原因 */
	removalReasons: Map<string, string>;
	/** 任务边界信号 */
	boundary: TaskBoundary;
}

// ============================================================================
// Deduplicator
// ============================================================================

export class Deduplicator {
	/**
	 * 对 L1 条目进行去重 + 噪声过滤 + 任务边界检测。
	 */
	deduplicate(input: DedupInput): DedupOutput {
		const { entries, prevEntries = [], verdict } = input;
		const kept: DedupEntry[] = [];
		const removed: string[] = [];
		const removalReasons = new Map<string, string>();

		// 构建上一轮摘要集合（用于去重）
		const prevSummaries = new Map<string, string>();
		for (const pe of prevEntries) {
			prevSummaries.set(pe.agentId, pe.summary);
		}

		for (const entry of entries) {
			// 噪声过滤：score < 3
			if (entry.score < 3) {
				removed.push(entry.agentId);
				removalReasons.set(entry.agentId, `低分噪声 (score=${entry.score})`);
				continue;
			}

			// 去重：同 agentId + 同摘要
			const prevSummary = prevSummaries.get(entry.agentId);
			if (prevSummary === entry.summary) {
				removed.push(entry.agentId);
				removalReasons.set(entry.agentId, "重复条目");
				continue;
			}

			kept.push(entry);
		}

		// 任务边界检测
		const boundary = this.#detectBoundary(verdict, kept, removed);

		logger.debug("[Deduplicator] Dedup complete", {
			input: entries.length,
			kept: kept.length,
			removed: removed.length,
			boundary: boundary.type,
		});

		return { kept, removed, removalReasons, boundary };
	}

	// -- Internal -------------------------------------------------------------

	#detectBoundary(
		verdict: ReviewVerdict | undefined,
		kept: DedupEntry[],
		removed: string[],
	): TaskBoundary {
		// 优先使用 Cloner 审查结果
		if (verdict) {
			if (verdict.passed) {
				return {
					type: "completed",
					reason: `Cloner 审查全部通过 (${verdict.approvalCount}/${verdict.totalCount})`,
				};
			}

			// 如果有分歧但还有进度
			if (verdict.disagreed && kept.length > 0) {
				return { type: "none" };
			}
		}

		// 如果全部被移除 + 无可保留项 → 可能阻塞
		if (removed.length > 0 && kept.length === 0) {
			return {
				type: "blocked",
				reason: `所有条目被过滤 (${removed.length} 条移除)`,
			};
		}

		return { type: "none" };
	}
}
