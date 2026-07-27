/**
 * hindsight-adapter.ts — swarm-side handle for the remote Hindsight memory API.
 *
 * The swarm run path never instantiates the main-session MemoryBackend, so it
 * has no access to Hindsight. This adapter exposes a narrow, testable interface
 * (`SwarmHindsightClient`) — mirroring the `MnemopiClient` pattern — that both
 * `HindsightSource` (recall → context injection) and the Curtain `LessonSink`
 * (retain → cross-session persistence) depend on.
 *
 * Everything here is best-effort: recall failures return `[]`, retain failures
 * are logged and swallowed. A remote outage must never block or crash the loop.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import { type BankScope, computeBankScope, ensureBankExists } from "../../hindsight/bank";
import { createHindsightClient, type HindsightApi, type MemoryItemInput } from "../../hindsight/client";
import { type HindsightConfig, isHindsightConfigured, loadHindsightConfig } from "../../hindsight/config";

// ============================================================================
// Narrow interface (allows runtime injection + trivial mocking in tests)
// ============================================================================

export interface HindsightRecallItem {
	text: string;
	type?: string | null;
}

export interface HindsightLessonItem {
	/** Full lesson body — becomes the memory content. */
	content: string;
	/** Short one-liner — attached as retrieval context. */
	summary?: string;
	tags?: string[];
	metadata?: Record<string, string>;
	/** Groups a batch of lessons under one document (typically the run id). */
	documentId?: string;
}

export interface SwarmHindsightClient {
	/** Semantic recall of cross-session memories relevant to `query`. */
	recall(query: string, opts?: { signal?: AbortSignal; maxTokens?: number }): Promise<HindsightRecallItem[]>;
	/** Fire-and-forget batch retain of lessons to the remote bank. */
	retainLessons(items: HindsightLessonItem[]): Promise<void>;
}

// ============================================================================
// HTTP implementation
// ============================================================================

class HttpSwarmHindsightClient implements SwarmHindsightClient {
	readonly #api: HindsightApi;
	readonly #scope: BankScope;
	readonly #config: HindsightConfig;
	readonly #banks = new Set<string>();

	constructor(api: HindsightApi, scope: BankScope, config: HindsightConfig) {
		this.#api = api;
		this.#scope = scope;
		this.#config = config;
	}

	async recall(query: string, opts?: { signal?: AbortSignal; maxTokens?: number }): Promise<HindsightRecallItem[]> {
		if (!query.trim()) return [];
		try {
			await this.#ensureBank();
			const response = await this.#api.recall(this.#scope.bankId, query, {
				tags: this.#scope.recallTags,
				tagsMatch: this.#scope.recallTagsMatch,
				budget: this.#config.recallBudget,
				maxTokens: opts?.maxTokens,
				signal: opts?.signal,
			});
			return (response.results ?? []).map(r => ({ text: r.text, type: r.type }));
		} catch (err) {
			logger.debug("[SwarmHindsight] recall failed", { bankId: this.#scope.bankId, error: String(err) });
			return [];
		}
	}

	async retainLessons(items: HindsightLessonItem[]): Promise<void> {
		if (items.length === 0) return;
		try {
			await this.#ensureBank();
			const memItems: MemoryItemInput[] = items.map(item => ({
				content: item.content,
				context: item.summary,
				metadata: item.metadata,
				documentId: item.documentId,
				// Merge project-scope retain tags so per-project-tagged recall matches.
				tags: mergeTags(item.tags, this.#scope.retainTags),
			}));
			await this.#api.retainBatch(this.#scope.bankId, memItems, {
				async: true,
				documentTags: this.#scope.retainTags,
			});
		} catch (err) {
			logger.warn("[SwarmHindsight] retainLessons failed", { bankId: this.#scope.bankId, error: String(err) });
		}
	}

	async #ensureBank(): Promise<void> {
		try {
			await ensureBankExists(this.#api, this.#scope.bankId, this.#config, this.#banks);
		} catch (err) {
			logger.debug("[SwarmHindsight] ensureBank failed (continuing)", { error: String(err) });
		}
	}
}

function mergeTags(a?: string[], b?: string[]): string[] | undefined {
	if (!a?.length && !b?.length) return undefined;
	return [...new Set([...(a ?? []), ...(b ?? [])])];
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Build a swarm Hindsight client from settings, or `null` when Hindsight is
 * not configured (no `hindsight.apiUrl`). Callers register sources/sinks
 * conditionally so an unconfigured environment degrades to a no-op.
 */
export function createSwarmHindsightClient(settings: Settings, cwd: string): SwarmHindsightClient | null {
	const config = loadHindsightConfig(settings);
	if (!isHindsightConfigured(config)) return null;
	const api = createHindsightClient(config);
	const scope = computeBankScope(config, cwd);
	return new HttpSwarmHindsightClient(api, scope, config);
}
