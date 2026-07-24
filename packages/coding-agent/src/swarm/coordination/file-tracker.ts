/**
 * FileTracker — 基于 git diff 的冲突检测层。
 *
 * 每轮开始时记录 HEAD tree hash；结束时用 git diff 找出变更文件，
 * 交叉比对 worker 输出来归属每个文件的写者。多 worker 碰同一文件 → 冲突报告。
 *
 * 不提供实时锁——冲突报告注入下一轮 roundtable prompt，worker 通过
 * AgentChannel IRC 自行协商。
 */

import { logger } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

// ============================================================================
// Types
// ============================================================================

export interface FileConflictReport {
	/** 冲突文件的相对路径 */
	file: string;
	/** 本轮写入该文件的 worker ID 列表 */
	writers: string[];
	/** 单 writer → "single"，多 writer → "overlap" */
	severity: "single" | "overlap";
}

export interface FileRoundSummary {
	/** 本轮所有变更文件 */
	changedFiles: string[];
	/** 其中被多个 worker 触碰的冲突文件 */
	conflicts: FileConflictReport[];
}

// ============================================================================
// Helpers
// ============================================================================

/** 从 worker 输出文本中提取文件路径（启发式，不要求 100% 精确）。 */
function extractFilePaths(output: string): Set<string> {
	const paths = new Set<string>();

	// Match patterns like: "src/foo.ts", "packages/x/src/bar.ts", "tests/x.test.ts"
	// Match common source file extensions in context of paths (looks for patterns like "src/foo.ts", "packages/x/src/bar.ts")
	const pathRegex = /\b([a-zA-Z0-9_\-./]+\.(?:ts|js|tsx|jsx|json|yaml|yml|md|rs|py|go|toml|lark))\b/g;
	for (const extracted of output.matchAll(pathRegex)) {
		const p = extracted[1].startsWith("/") ? extracted[1].slice(1) : extracted[1];
		// Filter noise: only keep paths that look like real source files (2+ dir levels or in known dirs)
		if (p.includes("/") && p.length > 4 && !p.includes("node_modules")) {
			paths.add(p);
		}
	}

	return paths;
}

/** 规范化路径：去掉前导 ./、统一分隔符。 */
function normalizeGitPath(p: string): string {
	return p.replace(/^\.\//, "").trim();
}

// ============================================================================
// FileTracker
// ============================================================================

export class FileTracker {
	#startTree: string | null = null;
	#writes: Map<string, Set<string>> = new Map();
	#workspace = "";

	/** 每轮开始：记录当前 HEAD tree hash 作为 baseline。 */
	async startRound(workspace: string): Promise<void> {
		this.#workspace = workspace;
		this.#writes.clear();
		this.#startTree = null;

		try {
			// Record current tree hash (fails gracefully if workspace is not a git repo)
			const result = await $`git rev-parse HEAD^{tree}`.cwd(workspace).quiet().nothrow();
			if (result.exitCode === 0) {
				this.#startTree = result.text().trim();
			}
		} catch {
			logger.debug("FileTracker: workspace is not a git repo, skipping", { workspace });
		}
	}

	/** 记录 worker 输出中引用的文件路径（归属分析用）。 */
	recordWorkerOutput(agentId: string, output: string): void {
		const paths = extractFilePaths(output);
		for (const p of paths) {
			const writers = this.#writes.get(p);
			if (writers) {
				writers.add(agentId);
			} else {
				this.#writes.set(p, new Set([agentId]));
			}
		}
	}

	/** 每轮结束：分析 git diff + worker 归属，返回冲突报告。 */
	async endRound(agentOutputs: Map<string, string>): Promise<FileRoundSummary> {
		try {
			// Record worker outputs for attribution
			for (const [agentId, output] of agentOutputs) {
				this.recordWorkerOutput(agentId, output);
			}

			// Get changed files via git diff
			const changedFiles: string[] = [];
			if (this.#startTree) {
				try {
					const diffResult = await $`git diff --name-only ${this.#startTree} HEAD -- .`
						.cwd(this.#workspace)
						.quiet()
						.nothrow();
					if (diffResult.exitCode === 0) {
						const raw = diffResult.text().trim();
						if (raw) {
							changedFiles.push(...raw.split("\n").map(normalizeGitPath).filter(Boolean));
						}
					}
				} catch (err) {
					logger.debug("FileTracker: git diff failed", { error: String(err) });
				}
			}

			// Cross-reference: changed files + worker attribution → conflicts
			const conflicts: FileConflictReport[] = [];
			const changedSet = new Set(changedFiles);

			for (const [file, writers] of this.#writes) {
				if (changedSet.has(file) && writers.size > 0) {
					conflicts.push({
						file,
						writers: [...writers],
						severity: writers.size > 1 ? "overlap" : "single",
					});
				}
			}

			// Also report changed files that appeared in NO worker output (unattributed)
			for (const file of changedFiles) {
				if (!this.#writes.has(file)) {
					conflicts.push({
						file,
						writers: [],
						severity: "single",
					});
				}
			}

			logger.debug("FileTracker: round analysis", {
				changedFiles: changedFiles.length,
				conflicts: conflicts.filter(c => c.severity === "overlap").length,
			});

			return { changedFiles, conflicts };
		} catch (err) {
			// Never throw from endRound — a failure here would hijack the outer catch
			// block in loop-controller, silently skipping all post-worker events
			// (conflict reporting, timeline tool_calls, file_change emissions,
			// todo-updated phases, cloner reviews, and verdict generation).
			logger.warn("FileTracker: endRound crashed, returning empty report", { error: String(err) });
			return { changedFiles: [], conflicts: [] };
		}
	}

	/**
	 * 生成冲突报告文本，用于注入 worker roundtable prompt。
	 * 空冲突 → 返回空字符串。
	 */
	static formatConflictReport(summary: FileRoundSummary): string {
		const overlapConflicts = summary.conflicts.filter(c => c.severity === "overlap");
		const unattributed = summary.conflicts.filter(c => c.writers.length === 0);

		if (overlapConflicts.length === 0 && unattributed.length === 0) {
			return "";
		}

		const lines: string[] = [];
		lines.push("## File Conflict Report (Prior Round)");
		lines.push("");

		if (overlapConflicts.length > 0) {
			lines.push("The following files were modified by **multiple workers** last round:");
			lines.push("");
			for (const c of overlapConflicts) {
				lines.push(`- \`${c.file}\` ← ${c.writers.join(", ")}`);
			}
			lines.push("");
			lines.push("⚠️ Coordinate via IRC before making further edits to these files.");
			lines.push("");
		}

		if (unattributed.length > 0) {
			lines.push("The following files changed but could not be attributed to a specific worker:");
			lines.push("");
			for (const c of unattributed) {
				lines.push(`- \`${c.file}\``);
			}
			lines.push("");
		}

		if (summary.conflicts.length > 1) {
			lines.push(
				"Pro-tip: discuss the conflict areas in the roundtable and agree on ownership boundaries before editing.",
			);
		} else if (overlapConflicts.length === 0) {
			lines.push("No file conflicts detected. Carry on.");
		}

		return lines.join("\n");
	}
}
