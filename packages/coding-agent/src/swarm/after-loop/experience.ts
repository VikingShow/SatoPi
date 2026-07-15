/**
 * ExperienceStore — Persistent loop experience storage.
 *
 * Layers:
 *   1. .omp/experience/lessons.jsonl   — append-only raw lessons
 *   2. .omp/experience/index.sqlite    — full-text search index (FTS5)
 *   3. .omp/experience/summaries/*.md  — human-readable summaries
 *
 * Design goals:
 *   - Efficient retrieval: sqlite FTS for keyword/concept search
 *   - Logical structuring: jsonl for chronological access
 *   - Human readability: markdown summaries for browsing
 *   - Load only relevant experience on-demand, not all at once
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
}

export interface SearchResult {
	runId: string;
	timestamp: string;
	lesson: ExtractedLesson;
	/** FTS rank (lower = better). */
	rank: number;
}

// ============================================================================
// Store
// ============================================================================

export class ExperienceStore {
	readonly #basePath: string;
	#db: Database | null = null;

	constructor(workspace: string) {
		this.#basePath = path.join(workspace, ".omp", "experience");
	}

	async init(): Promise<void> {
		await fs.mkdir(this.#basePath, { recursive: true });
		await fs.mkdir(path.join(this.#basePath, "summaries"), { recursive: true });

		this.#db = new Database(path.join(this.#basePath, "index.sqlite"));
		this.#initSchema();
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
	}

	/**
	 * Save a lesson from a loop run.
	 */
	saveLesson(entry: ExperienceEntry): void {
		const db = this.#db!;
		const sql = db.query(`
			INSERT INTO lessons (run_id, timestamp, lesson_json, stats_json, tags)
			VALUES (?1, ?2, ?3, ?4, ?5)
		`);

		sql.run(
			entry.runId,
			entry.timestamp,
			JSON.stringify(entry.lesson),
			JSON.stringify(entry.stats),
			entry.lesson.tags.join(", "),
		);

		// Also append to jsonl
		const jsonlPath = path.join(this.#basePath, "lessons.jsonl");
		fs.appendFile(jsonlPath, JSON.stringify(entry) + "\n").catch(() => {});
	}

	/**
	 * Full-text search across lessons.
	 */
	search(query: string, limit = 10): SearchResult[] {
		const db = this.#db!;
		const sql = db.query(`
			SELECT run_id, timestamp, lesson_json, rank
			FROM lessons_fts
			WHERE lessons_fts MATCH ?1
			ORDER BY rank
			LIMIT ?2
		`);

		const rows = sql.all(query, limit) as Array<{
			run_id: string;
			timestamp: string;
			lesson_json: string;
			rank: number;
		}>;

		return rows.map((row) => ({
			runId: row.run_id,
			timestamp: row.timestamp,
			lesson: JSON.parse(row.lesson_json) as ExtractedLesson,
			rank: row.rank,
		}));
	}

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

		return rows.map((row) => ({
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

		return rows.map((row) => ({
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

		return rows.map((row) => ({
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
		const stats = db.query(`
			SELECT
				COUNT(*) as total_runs,
				AVG(json_extract(stats_json, '$.totalIterations')) as avg_iterations,
				CAST(SUM(CASE WHEN json_extract(stats_json, '$.finalStatus') = 'completed' THEN 1 ELSE 0 END) AS REAL)
					/ MAX(1, COUNT(*)) as completion_rate,
				CAST(SUM(CASE WHEN json_extract(stats_json, '$.finalStatus') = 'escalated' THEN 1 ELSE 0 END) AS REAL)
					/ MAX(1, COUNT(*)) as escalation_rate,
				AVG(json_extract(stats_json, '$.clonerApprovalRatio')) as avg_approval_ratio
			FROM lessons
		`).get() as Record<string, number>;

		return {
			totalRuns: stats.total_runs ?? 0,
			avgIterations: Math.round((stats.avg_iterations ?? 0) * 100) / 100,
			completionRate: Math.round((stats.completion_rate ?? 0) * 100) / 100,
			escalationRate: Math.round((stats.escalation_rate ?? 0) * 100) / 100,
			avgApprovalRatio: Math.round((stats.avg_approval_ratio ?? 0) * 100) / 100,
		};
	}

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
