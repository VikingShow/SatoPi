/**
 * SwarmMnemopiAdapter — Phase 4 语义召回适配器
 *
 * 在 Swarm 循环的 4 个关键 hook 点集成 mnemopi 语义记忆：
 *
 *   1. beforeIteration — 召回与当前 plan/task 相关的历史记忆
 *   2. beforeWorkerRound — 将召回的上下文注入 Worker
 *   3. beforeClonerReview — 召回与审查相关的历史判定模式
 *   4. afterIteration   — 将关键决策写入 mnemopi（双写）
 */

import { logger } from "@oh-my-pi/pi-utils";

// ============================================================================
// Mnemopi 接口抽象（不直接依赖包，允许运行时注入）
// ============================================================================

export interface MnemopiClient {
	/** 语义召回 */
	recall(query: string, topK?: number): Promise<MnemopiRecallItem[]>;
	/** 存储记忆 */
	remember(content: string, metadata?: Record<string, unknown>): Promise<void>;
}

export interface MnemopiRecallItem {
	content: string;
	source?: string | null;
	score?: number;
	sessionId?: string;
	timestamp?: string | null;
}

// ============================================================================
// Types
// ============================================================================

export interface MnemopiAdapterConfig {
	/** 是否启用 */
	enabled: boolean;
	/** 召回 top-K */
	topK: number;
	/** 是否在 Worker 注入前做去重 */
	deduplicate: boolean;
	/** After-loop 自动写入的分数阈值（只有 score >= 此值的上下文才写入） */
	autoStoreThreshold: number;
}

export interface RecallResult {
	/** 召回的记忆条目 */
	items: MnemopiRecallItem[];
	/** 拼接后的上下文文本 */
	contextText: string;
}

// ============================================================================
// SwarmMnemopiAdapter
// ============================================================================

export class SwarmMnemopiAdapter {
	readonly #client: MnemopiClient;
	readonly #config: MnemopiAdapterConfig;

	/** 当前迭代已注入的 item hash，用于去重 */
	#injectedHashes = new Set<string>();

	constructor(client: MnemopiClient, config: MnemopiAdapterConfig) {
		this.#client = client;
		this.#config = config;
	}

	// ------------------------------------------------------------------------
	// Hook 1: beforeIteration — 召回与 plan/task 相关的历史记忆
	// ------------------------------------------------------------------------

	/**
	 * 在每次迭代开始前，基于 plan + task 描述召回相关历史记忆。
	 *
	 * @param planSummary  plan.md 的摘要或关键 phase 描述
	 * @param taskSummary  本轮任务的简短描述
	 */
	async recallForIteration(
		planSummary: string,
		taskSummary: string,
	): Promise<RecallResult | null> {
		if (!this.#config.enabled) return null;

		const query = [planSummary, taskSummary].filter(Boolean).join(" ").slice(0, 500);

		try {
			const items = await this.#client.recall(query, this.#config.topK);
			const contextText = this.#formatContext(items);

			logger.debug("[MnemopiAdapter] recallForIteration", {
				queryLen: query.length,
				items: items.length,
				contextLen: contextText.length,
			});

			return { items, contextText };
		} catch (err) {
			logger.warn("[MnemopiAdapter] recallForIteration failed", { error: String(err) });
			return null;
		}
	}

	// ------------------------------------------------------------------------
	// Hook 2: beforeWorkerRound — 构建 Worker 注入块
	// ------------------------------------------------------------------------

	/**
	 * 构建注入到 Worker 上下文的历史记忆块。
	 * 格式：
	 *
	 *   <historical_context>
	 *     [recalled memories from beforeIteration]
	 *   </historical_context>
	 */
	buildWorkerInjection(recallResult: RecallResult | null): string | null {
		if (!this.#config.enabled || !recallResult || recallResult.items.length === 0) {
			return null;
		}

		let contextText = recallResult.contextText;

		if (this.#config.deduplicate) {
			contextText = this.#dedupInjection(contextText);
		}

		if (!contextText) return null;

		return [
			"<historical_context>",
			contextText,
			"</historical_context>",
		].join("\n");
	}

	// ------------------------------------------------------------------------
	// Hook 3: beforeClonerReview — 召回审查相关的历史判定模式
	// ------------------------------------------------------------------------

	/**
	 * 在 Cloner 审查前，召回与"审查决策"相关的历史模式。
	 * 帮助 Cloner 参考类似场景下的历史判定。
	 */
	async recallForCloner(
		workerOutputs: string[],
		iteration: number,
	): Promise<RecallResult | null> {
		if (!this.#config.enabled) return null;

		const summary = workerOutputs.join(" ").slice(0, 500);
		const query = `审查 ${summary} (iteration ${iteration})`;

		try {
			const items = await this.#client.recall(query, Math.ceil(this.#config.topK / 2));
			const contextText = this.#formatContext(items);

			logger.debug("[MnemopiAdapter] recallForCloner", {
				items: items.length,
				iteration,
			});

			return { items, contextText };
		} catch (err) {
			logger.warn("[MnemopiAdapter] recallForCloner failed", { error: String(err) });
			return null;
		}
	}

	// ------------------------------------------------------------------------
	// Hook 4: afterIteration — 双写关键决策
	// ------------------------------------------------------------------------

	/**
	 * 在迭代完成后，将重要决策或产出写入 mnemopi。
	 *
	 * @param summary     迭代摘要
	 * @param score       质量评分 (0-10)
	 * @param metadata    附加元数据
	 */
	async storeAfterIteration(
		summary: string,
		score: number,
		metadata?: Record<string, unknown>,
	): Promise<void> {
		if (!this.#config.enabled) return;
		if (score < this.#config.autoStoreThreshold) {
			logger.debug("[MnemopiAdapter] Skipping store (below threshold)", { score });
			return;
		}

		try {
			await this.#client.remember(summary, {
				swarm_score: score,
				...metadata,
				source: "swarm-loop",
			});

			logger.debug("[MnemopiAdapter] Stored after iteration", {
				score,
				summaryLen: summary.length,
			});
		} catch (err) {
			logger.warn("[MnemopiAdapter] storeAfterIteration failed", { error: String(err) });
		}
	}

	// ------------------------------------------------------------------------
	// Helpers
	// ------------------------------------------------------------------------

	/**
	 * 将召回条目格式化为上下文字符串。
	 */
	#formatContext(items: MnemopiRecallItem[]): string {
		if (items.length === 0) return "";

		return items
			.map((item, i) => {
				const parts: string[] = [];
				parts.push(`[${i + 1}]`);
				if (item.score !== undefined) {
					parts.push(`(score: ${item.score.toFixed(2)})`);
				}
				parts.push(item.content.slice(0, 300));
				return parts.join(" ");
			})
			.join("\n");
	}

	/**
	 * 对注入文本做内容去重（基于 content hash）。
	 */
	#dedupInjection(text: string): string {
		if (!text) return text;

		const hash = this.#simpleHash(text);
		if (this.#injectedHashes.has(hash)) {
			logger.debug("[MnemopiAdapter] Skipping duplicate injection");
			return "";
		}

		this.#injectedHashes.add(hash);
		return text;
	}

	#simpleHash(str: string): string {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const chr = str.charCodeAt(i);
			hash = ((hash << 5) - hash) + chr;
			hash |= 0;
		}
		return String(hash);
	}

	// ------------------------------------------------------------------------
	// Lifecycle
	// ------------------------------------------------------------------------

	/** 清空去重缓存（新 session 时调用） */
	reset(): void {
		this.#injectedHashes.clear();
	}
}
