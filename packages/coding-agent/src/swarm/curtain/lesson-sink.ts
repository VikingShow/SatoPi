/**
 * lesson-sink.ts — fan-out of Curtain lessons to multiple memory backends.
 *
 * Curtain produces ExtractedLesson[] once (via extractLessons + reflectDeep).
 * A LessonSink persists them; MultiLessonSink fans one batch out to several
 * backends independently:
 *
 *   ExperienceStoreSink → local FTS5 store (authoritative, in-process)
 *   HindsightSink       → remote bank via retainBatch (cross-session)
 *   MnemopiSink         → semantic vector memory (best-effort)
 *
 * Design (narrow interface + divide-and-conquer + fail-soft fan-out):
 *   - Every sink is independent; one failing sink never blocks the others.
 *   - fanOut never throws — remote/vector failures are logged and swallowed,
 *     so a Curtain phase is never derailed by a memory backend being down.
 *   - Sinks are added only when their backing handle exists, so an
 *     unconfigured environment silently degrades to the local store alone.
 */

import { logger } from "@satopi/pi-utils";
import type { HindsightLessonItem, SwarmHindsightClient } from "../infra/hindsight-adapter";
import type { MnemopiClient } from "../infra/mnemopi-adapter";
import type { ExperienceStore } from "./experience";
import type { ExtractedLesson, LoopRunStats } from "./extractor";

// ============================================================================
// Interface
// ============================================================================

export interface LessonSink {
	readonly name: string;
	/** Persist a batch of lessons. Implementations must not assume exclusivity. */
	fanOut(
		lessons: ExtractedLesson[],
		stats: LoopRunStats,
		runId: string,
		metadata?: { graphName?: string; nodeId?: string; taskHash?: string },
	): Promise<void>;
}

// ============================================================================
// Concrete sinks
// ============================================================================

/**
 * Local ExperienceStore sink — the authoritative store. Writes are synchronous
 * FTS5 inserts wrapped in a promise. Preserves the exact runId convention
 * (`${runId}-${lesson.type}`) the Curtain runner relies on for decay.
 */
export class ExperienceStoreSink implements LessonSink {
	readonly name = "experience";
	readonly #store: ExperienceStore;

	constructor(store: ExperienceStore) {
		this.#store = store;
	}

	async fanOut(
		lessons: ExtractedLesson[],
		stats: LoopRunStats,
		runId: string,
		metadata?: { graphName?: string; nodeId?: string; taskHash?: string },
	): Promise<void> {
		for (const lesson of lessons) {
			this.#store.saveLesson({
				runId: `${runId}-${lesson.type}`,
				timestamp: new Date().toISOString(),
				lesson,
				stats,
				weight: 1.0,
				...(metadata ?? {}),
			});
		}
	}
}

/**
 * Remote Hindsight sink — pushes lessons to the cross-session bank via a
 * fire-and-forget batch retain. The adapter already swallows network errors,
 * so this is doubly fail-soft.
 */
export class HindsightSink implements LessonSink {
	readonly name = "hindsight";
	readonly #client: SwarmHindsightClient;

	constructor(client: SwarmHindsightClient) {
		this.#client = client;
	}

	async fanOut(
		lessons: ExtractedLesson[],
		_stats: LoopRunStats,
		runId: string,
		_metadata?: { graphName?: string; nodeId?: string; taskHash?: string },
	): Promise<void> {
		const items: HindsightLessonItem[] = lessons.map(lesson => ({
			content: lesson.detail,
			summary: lesson.summary,
			tags: [...(lesson.tags ?? []), `type:${lesson.type}`, "source:curtain"],
			metadata: {
				lesson_type: lesson.type,
				confidence: String(lesson.confidence),
				source: lesson.source,
			},
			documentId: runId,
		}));
		await this.#client.retainLessons(items);
	}
}

/**
 * Semantic memory sink — writes each lesson into Mnemopi so ordinary (non-swarm)
 * agents can recall swarm experience. Best-effort; only active when a client is
 * wired (interface-only this round).
 */
export class MnemopiSink implements LessonSink {
	readonly name = "mnemopi";
	readonly #client: MnemopiClient;

	constructor(client: MnemopiClient) {
		this.#client = client;
	}

	async fanOut(
		lessons: ExtractedLesson[],
		_stats: LoopRunStats,
		_runId: string,
		_metadata?: { graphName?: string; nodeId?: string; taskHash?: string },
	): Promise<void> {
		for (const lesson of lessons) {
			await this.#client.remember(lesson.detail, {
				lesson_type: lesson.type,
				confidence: lesson.confidence,
				tags: lesson.tags,
				source: "curtain",
			});
		}
	}
}

// ============================================================================
// Fan-out
// ============================================================================

export interface MultiLessonSinkDeps {
	experienceStore: ExperienceStore;
	hindsightClient?: SwarmHindsightClient | null;
	mnemopiClient?: MnemopiClient | null;
}

/**
 * Fans a lesson batch out to every configured sink concurrently. Uses
 * `Promise.allSettled` so one sink's failure is isolated, logged, and does not
 * reject the whole fan-out.
 */
export class MultiLessonSink implements LessonSink {
	readonly name = "multi";
	readonly #sinks: LessonSink[];

	constructor(sinks: LessonSink[]) {
		this.#sinks = sinks;
	}

	async fanOut(
		lessons: ExtractedLesson[],
		stats: LoopRunStats,
		runId: string,
		metadata?: { graphName?: string; nodeId?: string; taskHash?: string },
	): Promise<void> {
		if (lessons.length === 0) return;
		const results = await Promise.allSettled(this.#sinks.map(s => s.fanOut(lessons, stats, runId, metadata)));
		results.forEach((r, i) => {
			if (r.status === "rejected") {
				logger.warn(`[LessonSink] sink "${this.#sinks[i]?.name}" failed`, { error: String(r.reason) });
			}
		});
	}

	/** Build a fan-out from available handles. ExperienceStore is always present. */
	static create(deps: MultiLessonSinkDeps): MultiLessonSink {
		const sinks: LessonSink[] = [new ExperienceStoreSink(deps.experienceStore)];
		if (deps.hindsightClient) sinks.push(new HindsightSink(deps.hindsightClient));
		if (deps.mnemopiClient) sinks.push(new MnemopiSink(deps.mnemopiClient));
		return new MultiLessonSink(sinks);
	}
}
