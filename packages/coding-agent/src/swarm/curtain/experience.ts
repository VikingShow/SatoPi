/**
 * ExperienceStore — Persistent loop experience storage.
 *
 * Layers:
 *   1. .omp/experience/lessons.jsonl   — append-only raw lessons
 *   2. .omp/experience/index.sqlite    — full-text search index (FTS5)
 *   3. .omp/experience/summaries/*.md  — human-readable summaries
 *   4. .omp/experience/principles.jsonl — aggregated wisdom principles
 *
 * Design goals:
 *   - Efficient retrieval: sqlite FTS for keyword/concept search
 *   - Logical structuring: jsonl for chronological access
 *   - Human readability: markdown summaries for browsing
 *   - Load only relevant experience on-demand, not all at once
 *   - Dedup: merge similar lessons to prevent bloat
 *   - Decay: unreferenced lessons lose weight over time
 *   - Semantic: synonym expansion for cross-language matching
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtractedLesson, LoopRunStats } from "./extractor";

// ============================================================================
// Types
// ============================================================================

export interface ExperienceEntry {
	/** Unique run ID (timestamp-based). */
	runId: string;
	/** When this loop ran. */
	timestamp: string;
	/** The lesson data. */
	lesson: ExtractedLesson;
	/** Loop run statistics context. */
	stats: LoopRunStats;
	/** Experience quality weight (0.1–5.0). Initial 1.0, boosted on reference, decayed when unreferenced. */
	weight?: number;
	/** ISO timestamp of last reference by a reviewer during planning. */
	lastReferencedAt?: string;
}

export interface SearchResult {
	runId: string;
	timestamp: string;
	lesson: ExtractedLesson;
	/** FTS rank (lower = better), adjusted by weight. */
	rank: number;
}

/** Aggregated wisdom principle from multiple runs. */
export interface Principle {
	/** Unique principle ID. */
	id: string;
	/** The principle summary. */
	summary: string;
	/** Detailed explanation. */
	detail: string;
	/** Source run IDs that contributed. */
	sourceRunIds: string[];
	/** When this principle was generated. */
	generatedAt: string;
	/** Confidence (LLM self-assessed). */
	confidence: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Jaccard similarity threshold for merging lessons. */
const DEDUP_THRESHOLD = 0.7;

/** Weight increment on reference (+10%). */
const REFERENCE_BOOST = 0.1;

/** Weight decay factor per unreferenced run. */
const DECAY_FACTOR = 0.9;

/** Minimum weight floor. */
const MIN_WEIGHT = 0.1;

/** Number of runs between principle generation. */
const PRINCIPLE_INTERVAL = 10;

/** Maximum lessons to check for dedup per save. */
const DEDUP_SEARCH_LIMIT = 5;

/** Synonym map for cross-language FTS5 expansion. */
const SYNONYMS: Record<string, string[]> = {
	timeout: ["超时"],
	error: ["错误", "失败"],
	failure: ["失败", "错误"],
	security: ["安全"],
	performance: ["性能"],
	concurrency: ["并发"],
	memory: ["内存"],
	"dead lock": ["死锁"],
	deadlock: ["死锁"],
	consensus: ["共识", "一致"],
	consistency: ["一致性", "一致"],
	convergence: ["收敛"],
	converge: ["收敛"],
	review: ["审查", "评审"],
	reviewer: ["审查者"],
	agent: ["工作者", "执行者"],
	"plan.md": ["计划"],
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Jaccard similarity between two strings based on word tokens.
 * Returns 0–1 where 1 = identical token sets.
 */
function calculateSimilarity(a: string, b: string): number {
	const tokenize = (s: string): Set<string> =>
		new Set(
			s
				.toLowerCase()
				.split(/[^a-z0-9\u4e00-\u9fff]+/)
				.filter(t => t.length > 0),
		);

	const tokensA = tokenize(a);
	const tokensB = tokenize(b);

	if (tokensA.size === 0 && tokensB.size === 0) return 0;

	const intersection = new Set([...tokensA].filter(t => tokensB.has(t)));
	const union = new Set([...tokensA, ...tokensB]);

	return intersection.size / union.size;
}

/**
 * Expand a query string with synonyms for cross-language matching.
 * Wraps terms in FTS5-compatible OR groups.
 */
function expandQuery(query: string): string {
	const terms = query
		.toLowerCase()
		.split(/[^a-z0-9\u4e00-\u9fff]+/)
		.filter(t => t.length > 0);

	const expanded: string[] = [];
	const seen = new Set<string>();

	for (const term of terms) {
		if (seen.has(term)) continue;
		seen.add(term);

		const synonyms = SYNONYMS[term];
		if (synonyms && synonyms.length > 0) {
			const group = [term, ...synonyms.filter(s => !seen.has(s))];
			for (const s of synonyms) seen.add(s);
			expanded.push(`(${group.map(quoteFts5Term).join(" OR ")})`);
		} else {
			expanded.push(quoteFts5Term(term));
		}
	}

	return expanded.join(" ");
}

/** Quote a term for FTS5 MATCH — wrap in double quotes if it contains special chars. */
function quoteFts5Term(term: string): string {
	if (/[^\w\u4e00-\u9fff]/.test(term)) {
		return `"${term}"`;
	}
	return term;
}

// ============================================================================
// Store
// ============================================================================

export class ExperienceStore {
	readonly #basePath: string;
	#db: Database | null = null;
	#schemaVersion = 0;

	constructor(workspace: string) {
		this.#basePath = path.join(workspace, ".omp", "experience");
	}

	async init(): Promise<void> {
		await fs.mkdir(this.#basePath, { recursive: true });
		await fs.mkdir(path.join(this.#basePath, "summaries"), { recursive: true });

		this.#db = new Database(path.join(this.#basePath, "index.sqlite"));
		this.#initSchema();
		this.#migrateSchema();
	}

	#initSchema(): void {
		const db = this.#db!;
		db.run(`
			CREATE TABLE IF NOT EXISTS lessons (
				run_id TEXT PRIMARY KEY,
				timestamp TEXT NOT NULL,
				lesson_json TEXT NOT NULL,
				stats_json TEXT NOT NULL,
				tags TEXT NOT NULL
			)
		`);
		db.run(`
			CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(
				run_id UNINDEXED,
				summary,
				detail,
				tags,
				content=lessons,
				content_rowid=rowid
			)
		`);

		// Triggers to keep FTS in sync
		db.run(`
			CREATE TRIGGER IF NOT EXISTS lessons_ai AFTER INSERT ON lessons BEGIN
				INSERT INTO lessons_fts(rowid, run_id, summary, detail, tags)
				VALUES (
					new.rowid,
					new.run_id,
					json_extract(new.lesson_json, '$.summary'),
					json_extract(new.lesson_json, '$.detail'),
					new.tags
				);
			END
		`);
		db.run(`
			CREATE TRIGGER IF NOT EXISTS lessons_ad AFTER DELETE ON lessons BEGIN
				INSERT INTO lessons_fts(lessons_fts, rowid, run_id, summary, detail, tags)
				VALUES ('delete', old.rowid, old.run_id, '', '', '');
			END
		`);
		db.run(`
			CREATE TRIGGER IF NOT EXISTS lessons_au AFTER UPDATE ON lessons BEGIN
				INSERT INTO lessons_fts(lessons_fts, rowid, run_id, summary, detail, tags)
				VALUES ('delete', old.rowid, old.run_id, '', '', '');
				INSERT INTO lessons_fts(rowid, run_id, summary, detail, tags)
				VALUES (
					new.rowid,
					new.run_id,
					json_extract(new.lesson_json, '$.summary'),
					json_extract(new.lesson_json, '$.detail'),
					new.tags
				);
			END
		`);

		// Schema version tracking
		db.run(`
			CREATE TABLE IF NOT EXISTS schema_version (
				version INTEGER PRIMARY KEY
			)
		`);
	}

	/**
	 * Migrate schema: v0→v1 adds weight and last_referenced_at columns.
	 */
	#migrateSchema(): void {
		const db = this.#db!;

		// Read current version
		const versionRow = db.query("SELECT MAX(version) as v FROM schema_version").get() as
			| { v: number | null }
			| undefined;
		this.#schemaVersion = versionRow?.v ?? 0;

		if (this.#schemaVersion < 1) {
			// v1: add weight + last_referenced_at for experience decay
			try {
				db.run("ALTER TABLE lessons ADD COLUMN weight REAL DEFAULT 1.0");
			} catch {
				// column already exists (edge case)
			}
			try {
				db.run("ALTER TABLE lessons ADD COLUMN last_referenced_at TEXT");
			} catch {
				// column already exists
			}

			// Set default weight for existing rows
			db.run("UPDATE lessons SET weight = 1.0 WHERE weight IS NULL");

			db.run("INSERT OR REPLACE INTO schema_version (version) VALUES (1)");
			this.#schemaVersion = 1;
		}
	}

	// ========================================================================
	// Save
	// ========================================================================

	/**
	 * Save a lesson from a loop run, with dedup: if a similar lesson exists
	 * (Jaccard > 0.7 on summary), merge instead of inserting duplicate.
	 */
	saveLesson(entry: ExperienceEntry): void {
		// Search for similar existing lessons
		const similarLessons = this.#findSimilar(entry.lesson.summary, DEDUP_SEARCH_LIMIT);

		for (const existing of similarLessons) {
			const similarity = calculateSimilarity(entry.lesson.summary, existing.lesson.summary);
			if (similarity > DEDUP_THRESHOLD) {
				this.#mergeLesson(existing.runId, entry);
				return; // merged, don't insert new
			}
		}

		// No similar lesson found — insert new
		this.#insertLesson(entry);
	}

	/**
	 * Search for lessons with similar text via FTS5, returning raw entries.
	 */
	#findSimilar(text: string, limit: number): ExperienceEntry[] {
		const db = this.#db!;

		// Build a broad search query from the summary text
		const terms = text
			.toLowerCase()
			.split(/[^a-z0-9\u4e00-\u9fff]+/)
			.filter(t => t.length > 1)
			.slice(0, 10)
			.map(quoteFts5Term)
			.join(" OR ");

		if (!terms) return [];

		try {
			const rows = db
				.query(
					`
				SELECT l.run_id, l.timestamp, l.lesson_json, l.stats_json
				FROM lessons_fts fts
				JOIN lessons l ON l.run_id = fts.run_id
				WHERE lessons_fts MATCH ?1
				ORDER BY rank
				LIMIT ?2
			`,
				)
				.all(terms, limit) as Array<{
				run_id: string;
				timestamp: string;
				lesson_json: string;
				stats_json: string;
			}>;

			return rows.map(row => ({
				runId: row.run_id,
				timestamp: row.timestamp,
				lesson: JSON.parse(row.lesson_json) as ExtractedLesson,
				stats: JSON.parse(row.stats_json) as LoopRunStats,
			}));
		} catch {
			return [];
		}
	}

	/**
	 * Merge a new lesson into an existing one: append detail, union tags,
	 * average confidence, update timestamp.
	 */
	#mergeLesson(existingRunId: string, incoming: ExperienceEntry): void {
		const db = this.#db!;

		const existing = db.query("SELECT lesson_json, tags FROM lessons WHERE run_id = ?1").get(existingRunId) as
			| { lesson_json: string; tags: string }
			| undefined;

		if (!existing) {
			this.#insertLesson(incoming);
			return;
		}

		const existingLesson: ExtractedLesson = JSON.parse(existing.lesson_json);
		const existingTags = new Set(existing.tags.split(/,\s*/).filter(Boolean));
		for (const tag of incoming.lesson.tags) existingTags.add(tag);

		const mergedLesson: ExtractedLesson = {
			...existingLesson,
			summary:
				existingLesson.summary.length >= incoming.lesson.summary.length
					? existingLesson.summary
					: incoming.lesson.summary,
			detail: `${existingLesson.detail}\n\n--- merged from ${incoming.runId} ---\n${incoming.lesson.detail}`,
			tags: [...existingTags],
			confidence: Math.round(((existingLesson.confidence + incoming.lesson.confidence) / 2) * 100) / 100,
			source: `${existingLesson.source}, ${incoming.lesson.source}`,
		};

		db.run(
			`
			UPDATE lessons
			SET lesson_json = ?1, tags = ?2, timestamp = ?3
			WHERE run_id = ?4
		`,
			[JSON.stringify(mergedLesson), [...existingTags].join(", "), incoming.timestamp, existingRunId],
		);

		// Also append merged entry to jsonl for audit trail
		const jsonlPath = path.join(this.#basePath, "lessons.jsonl");
		const mergedEntry: ExperienceEntry = {
			...incoming,
			runId: `${existingRunId}-merged-${Date.now()}`,
			lesson: mergedLesson,
		};
		fs.appendFile(jsonlPath, `${JSON.stringify(mergedEntry)}\n`).catch(() => {});
	}

	/**
	 * Insert a brand-new lesson.
	 */
	#insertLesson(entry: ExperienceEntry): void {
		const db = this.#db!;
		const weight = entry.weight ?? 1.0;
		const sql = db.query(`
			INSERT INTO lessons (run_id, timestamp, lesson_json, stats_json, tags, weight, last_referenced_at)
			VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
		`);

		sql.run(
			entry.runId,
			entry.timestamp,
			JSON.stringify(entry.lesson),
			JSON.stringify(entry.stats),
			entry.lesson.tags.join(", "),
			weight,
			entry.lastReferencedAt ?? null,
		);

		// Also append to jsonl
		const jsonlPath = path.join(this.#basePath, "lessons.jsonl");
		fs.appendFile(jsonlPath, `${JSON.stringify(entry)}\n`).catch(() => {});
	}

	// ========================================================================
	// Search
	// ========================================================================

	/**
	 * Full-text search across lessons with synonym expansion and weight-aware ranking.
	 * Results ordered by (rank * (1 / weight)) so higher-weight lessons rank better.
	 */
	search(query: string, limit = 10): SearchResult[] {
		const db = this.#db!;
		const expandedQuery = expandQuery(query);

		try {
			const sql = db.query(`
				SELECT fts.run_id, l.timestamp, l.lesson_json, fts.rank, l.weight
				FROM lessons_fts fts
				JOIN lessons l ON l.run_id = fts.run_id
				WHERE lessons_fts MATCH ?1
				ORDER BY fts.rank * (1.0 / MAX(0.01, COALESCE(l.weight, 1.0)))
				LIMIT ?2
			`);

			const rows = sql.all(expandedQuery, limit) as Array<{
				run_id: string;
				timestamp: string;
				lesson_json: string;
				rank: number;
				weight: number | null;
			}>;

			return rows.map(row => ({
				runId: row.run_id,
				timestamp: row.timestamp,
				lesson: JSON.parse(row.lesson_json) as ExtractedLesson,
				rank: row.rank * (1.0 / Math.max(0.01, row.weight ?? 1.0)),
			}));
		} catch {
			// Fallback: try with raw query if expansion breaks FTS5 syntax
			const sql = db.query(`
				SELECT fts.run_id, l.timestamp, l.lesson_json, fts.rank, l.weight
				FROM lessons_fts fts
				JOIN lessons l ON l.run_id = fts.run_id
				WHERE lessons_fts MATCH ?1
				ORDER BY fts.rank * (1.0 / MAX(0.01, COALESCE(l.weight, 1.0)))
				LIMIT ?2
			`);

			const rows = sql.all(query, limit) as Array<{
				run_id: string;
				timestamp: string;
				lesson_json: string;
				rank: number;
				weight: number | null;
			}>;

			return rows.map(row => ({
				runId: row.run_id,
				timestamp: row.timestamp,
				lesson: JSON.parse(row.lesson_json) as ExtractedLesson,
				rank: row.rank * (1.0 / Math.max(0.01, row.weight ?? 1.0)),
			}));
		}
	}

	// ========================================================================
	// Experience Decay
	// ========================================================================

	/**
	 * Mark lessons as referenced — boosts their weight by 10%.
	 * Call this when a Cloner references past lessons during Before Loop planning.
	 */
	markReferenced(runIds: string[]): void {
		if (runIds.length === 0) return;
		const db = this.#db!;

		const now = new Date().toISOString();
		const stmt = db.query(`
			UPDATE lessons
			SET weight = MIN(5.0, COALESCE(weight, 1.0) + ?1),
			    last_referenced_at = ?2
			WHERE run_id = ?3
		`);

		for (const runId of runIds) {
			stmt.run(REFERENCE_BOOST, now, runId);
		}
	}

	/**
	 * Decay lessons that were not referenced in the current run.
	 * Call once per loop run (After Loop phase).
	 * Lessons not referenced in 10+ runs get their weight multiplied by 0.9 each run.
	 */
	decayUnreferenced(currentRunIds: string[]): void {
		const db = this.#db!;

		// Decay all lessons that were NOT in the current run's referenced set,
		// and whose weight is above the floor.
		if (currentRunIds.length > 0) {
			const placeholders = currentRunIds.map(() => "?").join(", ");
			db.run(
				`
				UPDATE lessons
				SET weight = MAX(?1, COALESCE(weight, 1.0) * ?2)
				WHERE run_id NOT IN (${placeholders})
				  AND COALESCE(weight, 1.0) > ?1
			`,
				[MIN_WEIGHT, DECAY_FACTOR, ...currentRunIds],
			);
		} else {
			// No lessons referenced this run — decay all
			db.run(
				`
				UPDATE lessons
				SET weight = MAX(?1, COALESCE(weight, 1.0) * ?2)
				WHERE COALESCE(weight, 1.0) > ?1
			`,
				[MIN_WEIGHT, DECAY_FACTOR],
			);
		}
	}
	// ========================================================================
	// Query
	// ========================================================================

	/**
	 * Get all lessons from a specific run.
	 */
	getRunLessons(runId: string): ExperienceEntry[] {
		const db = this.#db!;
		const sql = db.query(`
			SELECT run_id, timestamp, lesson_json, stats_json
			FROM lessons
			WHERE run_id = ?1
		`);
		const rows = sql.all(runId) as Array<{
			run_id: string;
			timestamp: string;
			lesson_json: string;
			stats_json: string;
		}>;
		return rows.map(row => ({
			runId: row.run_id,
			timestamp: row.timestamp,
			lesson: JSON.parse(row.lesson_json) as ExtractedLesson,
			stats: JSON.parse(row.stats_json) as LoopRunStats,
		}));
	}

	/**
	 * Get recent lessons (most recent first).
	 */
	getRecentLessons(limit = 20): ExperienceEntry[] {
		const db = this.#db!;
		const sql = db.query(`
			SELECT run_id, timestamp, lesson_json, stats_json
			FROM lessons
			ORDER BY timestamp DESC
			LIMIT ?1
		`);
		const rows = sql.all(limit) as Array<{
			run_id: string;
			timestamp: string;
			lesson_json: string;
			stats_json: string;
		}>;
		return rows.map(row => ({
			runId: row.run_id,
			timestamp: row.timestamp,
			lesson: JSON.parse(row.lesson_json) as ExtractedLesson,
			stats: JSON.parse(row.stats_json) as LoopRunStats,
		}));
	}

	/**
	 * Get lessons by tag.
	 */
	getByTag(tag: string, limit = 20): ExperienceEntry[] {
		const db = this.#db!;
		const sql = db.query(`
			SELECT run_id, timestamp, lesson_json, stats_json
			FROM lessons
			WHERE tags LIKE ?1
			ORDER BY timestamp DESC
			LIMIT ?2
		`);
		const rows = sql.all(`%${tag}%`, limit) as Array<{
			run_id: string;
			timestamp: string;
			lesson_json: string;
			stats_json: string;
		}>;
		return rows.map(row => ({
			runId: row.run_id,
			timestamp: row.timestamp,
			lesson: JSON.parse(row.lesson_json) as ExtractedLesson,
			stats: JSON.parse(row.stats_json) as LoopRunStats,
		}));
	}

	/**
	 * Get principles (aggregated wisdom), highest weight first.
	 */
	getPrinciples(limit = 10): ExperienceEntry[] {
		const db = this.#db!;
		const sql = db.query(`
			SELECT run_id, timestamp, lesson_json, stats_json
			FROM lessons
			WHERE tags LIKE '%principle%'
			ORDER BY COALESCE(weight, 1.0) DESC
			LIMIT ?1
		`);
		const rows = sql.all(limit) as Array<{
			run_id: string;
			timestamp: string;
			lesson_json: string;
			stats_json: string;
		}>;
		return rows.map(row => ({
			runId: row.run_id,
			timestamp: row.timestamp,
			lesson: JSON.parse(row.lesson_json) as ExtractedLesson,
			stats: JSON.parse(row.stats_json) as LoopRunStats,
		}));
	}

	/**
	 * Aggregate stats across all runs.
	 */
	getAggregateStats(): {
		totalRuns: number;
		avgIterations: number;
		completionRate: number;
		escalationRate: number;
		avgApprovalRatio: number;
	} {
		const db = this.#db!;
		const sql = db.query(`
			SELECT
				COUNT(*) as total_runs,
				AVG(json_extract(stats_json, '$.totalIterations')) as avg_iterations,
				CAST(SUM(CASE WHEN json_extract(stats_json, '$.finalStatus') = 'completed' THEN 1 ELSE 0 END) AS REAL)
					/ MAX(1, COUNT(*)) as completion_rate,
				CAST(SUM(CASE WHEN json_extract(stats_json, '$.finalStatus') = 'escalated' THEN 1 ELSE 0 END) AS REAL)
					/ MAX(1, COUNT(*)) as escalation_rate,
				AVG(json_extract(stats_json, '$.reviewApprovalRatio')) as avg_approval_ratio
			FROM lessons
			WHERE tags NOT LIKE '%principle%'
		`);
		const stats = sql.get() as Record<string, number>;
		return {
			totalRuns: stats.total_runs ?? 0,
			avgIterations: Math.round((stats.avg_iterations ?? 0) * 100) / 100,
			completionRate: Math.round((stats.completion_rate ?? 0) * 100) / 100,
			escalationRate: Math.round((stats.escalation_rate ?? 0) * 100) / 100,
			avgApprovalRatio: Math.round((stats.avg_approval_ratio ?? 0) * 100) / 100,
		};
	}

	// ========================================================================
	// Wisdom Summary (Principles)
	// ========================================================================

	/**
	 * Check if principles should be generated (every N runs).
	 */
	shouldGeneratePrinciples(): boolean {
		const stats = this.getAggregateStats();
		return stats.totalRuns > 0 && stats.totalRuns % PRINCIPLE_INTERVAL === 0;
	}

	/**
	 * Build the LLM prompt for generating principles from recent lessons.
	 * Returns the prompt text — the caller handles the actual LLM invocation.
	 */
	async buildPrinciplesPrompt(): Promise<string> {
		const recent = this.getRecentLessons(PRINCIPLE_INTERVAL * 2);

		const lessonText = recent
			.map(
				l =>
					`- [${l.lesson.type}] ${l.lesson.summary}\n  Tags: ${l.lesson.tags.join(", ")}\n  Detail: ${l.lesson.detail.slice(0, 300)}`,
			)
			.join("\n\n");

		return [
			"## Task: Synthesize Engineering Principles",
			"",
			`Analyze the following ${recent.length} lessons from recent Loop Engineering runs.`,
			"Extract 3-5 high-level engineering principles that emerge across multiple lessons.",
			"",
			"Output JSON format:",
			`{ "principles": [{ "summary": "...", "detail": "...", "confidence": 0.8 }] }`,
			"",
			"Rules:",
			"- A principle must be supported by at least 2 distinct lessons",
			"- Principles should be actionable, not vague truisms",
			"- Confidence: how strongly the data supports this principle (0-1)",
			"- Prioritize patterns that span multiple run types (success/failure/escalation)",
			"",
			"## Lessons",
			"",
			lessonText,
		].join("\n");
	}

	/**
	 * Save a generated principle as a lesson entry with high weight.
	 */
	savePrinciple(principle: Principle): void {
		const lesson: ExtractedLesson = {
			type: "pattern" as const,
			summary: principle.summary,
			detail: principle.detail,
			tags: ["principle", "aggregated", "wisdom"],
			confidence: principle.confidence,
			source: `principle-generator (${principle.sourceRunIds.length} runs)`,
		};

		const entry: ExperienceEntry = {
			runId: principle.id,
			timestamp: principle.generatedAt,
			lesson,
			stats: {
				totalIterations: 0,
				finalStatus: "completed",
				reviewApprovalRatio: 1,
				agentCount: 0,
				
				taskDescription: "principle-generation",
			},
		};

		// Principles get a weight boost upfront
		const db = this.#db!;
		db.run(
			`
			INSERT OR REPLACE INTO lessons (run_id, timestamp, lesson_json, stats_json, tags, weight)
			VALUES (?1, ?2, ?3, ?4, ?5, 3.0)
		`,
			[
				entry.runId,
				entry.timestamp,
				JSON.stringify(entry.lesson),
				JSON.stringify(entry.stats),
				entry.lesson.tags.join(", "),
			],
		);
		// Also append to main jsonl
		const jsonlPath = path.join(this.#basePath, "lessons.jsonl");
		fs.appendFile(jsonlPath, `${JSON.stringify(entry)}\n`).catch(() => {});
	}

	// ========================================================================
	// Output
	// ========================================================================

	/**
	 * Write a human-readable markdown summary.
	 */
	async writeSummary(runId: string, summary: string): Promise<void> {
		const filePath = path.join(this.#basePath, "summaries", `${runId}.md`);
		await Bun.write(filePath, summary);
	}

	/**
	 * Close the database connection.
	 */
	close(): void {
		this.#db?.close();
		this.#db = null;
	}
}
