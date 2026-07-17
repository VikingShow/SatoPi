/**
 * TodoTracker — Parses plan.md into structured TodoItems and tracks
 * real-time completion status during loop execution.
 *
 * Two core methods:
 *   1. parsePlan(content) — extract todo items from markdown
 *   2. updateFromWorkerOutput(output, todos) — match worker round summaries
 *      to todo items and update their status
 */

import type { TodoItem } from "./state";

// ============================================================================
// Regex patterns for plan.md parsing
// ============================================================================

/** Markdown checkbox: `- [ ] task` or `- [x] task` */
const CHECKBOX_ITEM = /^[-*]\s+\[( |x|X)\]\s+(.+)/gm;

/** Heading with step/phase/number: `## Step 1`, `### 1. task`, `## Phase 2` */
const HEADING_TASK = /^#{1,3}\s+(?:Step\s+|Phase\s+|Task\s+|Item\s+|Goal\s+)?(\d+[.)]?\s+.+)/gim;

/** Plain numbered list: `1. task` or `1) task` */
const NUMBERED_ITEM = /^(\d+[.)]\s+.+)/gm;

/** File path references in worker output: `src/foo/bar.ts`, `packages/x/y.ts` */
const FILE_REF = /(?:Created|Modified|Wrote|Updated|Added|Deleted|Renamed)\s+(?:file\s+)?[`']?([\w./-]+\.\w{1,6})[`']?/gi;

/** "Completed:" or "Done:" sections in worker output */
const COMPLETED_SECTION = /(?:^|\n)(?:##\s*)?(?:Completed|Done|Finished|Accomplished)[:\s]*\n([\s\S]*?)(?=\n##|\n---|\n\*\*\*|$)/i;

/** "## Round Summary" section */
const ROUND_SUMMARY = /##\s*Round\s+Summary\s*\n([\s\S]*?)(?=\n##\s|\n```|\n---\n|---|\n\*\*\*|\n___|$)/i;

// ============================================================================
// Slugify utility
// ============================================================================

function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/[\s_]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
}

// ============================================================================
// TodoTracker
// ============================================================================

export class TodoTracker {
	#todos: TodoItem[] = [];

	/** Parse plan.md content into structured TodoItems. */
	parsePlan(content: string): TodoItem[] {
		if (!content || content.trim().length === 0) {
			this.#todos = [];
			return this.#todos;
		}

		const items: TodoItem[] = [];
		const seenIds = new Set<string>();

		// 1. Match checkbox items first (highest priority — explicit task markers)
		for (const match of content.matchAll(CHECKBOX_ITEM)) {
			const isChecked = match[1].toLowerCase() === "x";
			const title = match[2].trim();
			const id = this.#uniqueId(slugify(title), seenIds);
			seenIds.add(id);
			items.push({
				id,
				title,
				status: isChecked ? "completed" : "pending",
				completedAt: isChecked ? Date.now() : undefined,
			});
		}

		// 2. Match heading-based tasks (## Step 1, ### 1. task, etc.)
		if (items.length === 0) {
			for (const match of content.matchAll(HEADING_TASK)) {
				const title = match[1].trim();
				const id = this.#uniqueId(slugify(title), seenIds);
				seenIds.add(id);
				items.push({ id, title, status: "pending" });
			}
		}

		// 3. Fallback: plain numbered list items
		if (items.length === 0) {
			for (const match of content.matchAll(NUMBERED_ITEM)) {
				const title = match[1].trim();
				const id = this.#uniqueId(slugify(title), seenIds);
				seenIds.add(id);
				items.push({ id, title, status: "pending" });
			}
		}

		this.#todos = items;
		return this.#todos;
	}

	/**
	 * Update todo statuses based on worker round summary output.
	 * Looks for:
	 *   - "## Round Summary" or "Completed:" sections
	 *   - File paths mentioned as created/modified
	 *   - Title keyword matching against completed items
	 */
	updateFromWorkerOutput(output: string, todos: TodoItem[]): TodoItem[] {
		if (!output || todos.length === 0) return todos;

		// Extract file paths mentioned as created/modified in worker output
		const mentionedFiles = new Set<string>();
		for (const match of output.matchAll(FILE_REF)) {
			mentionedFiles.add(match[1].toLowerCase());
		}

		// Extract text from "Completed:" / "Done:" / "## Round Summary" sections
		const completedTexts: string[] = [];

		const summaryMatch = output.match(ROUND_SUMMARY);
		if (summaryMatch?.[1]) {
			completedTexts.push(summaryMatch[1]);
		}

		const completedMatch = output.match(COMPLETED_SECTION);
		if (completedMatch?.[1]) {
			completedTexts.push(completedMatch[1]);
		}

		const completedBlob = completedTexts.join("\n").toLowerCase();

		// Track which todos have been touched in this update
		let hasInProgress = false;
		const updated = todos.map((todo) => {
			if (todo.status === "completed") return todo;

			// Match by file paths associated with the todo
			if (todo.files && todo.files.length > 0) {
				const allFilesDone = todo.files.every((f) => mentionedFiles.has(f.toLowerCase()));
				if (allFilesDone) {
					return { ...todo, status: "completed" as const, completedAt: Date.now() };
				}
				// If some files are mentioned, mark as in_progress
				const someFilesDone = todo.files.some((f) => mentionedFiles.has(f.toLowerCase()));
				if (someFilesDone) {
					hasInProgress = true;
					return { ...todo, status: "in_progress" as const };
				}
			}

			// Match by title keywords in completed text
			if (completedBlob.length > 0) {
				const titleKeywords = this.#extractKeywords(todo.title);
				if (titleKeywords.length > 0) {
					const matchedKeywords = titleKeywords.filter((kw) => completedBlob.includes(kw));
					// If all significant keywords are found in completed text, mark as completed
					if (matchedKeywords.length >= Math.ceil(titleKeywords.length * 0.6)) {
						return { ...todo, status: "completed" as const, completedAt: Date.now() };
					}
					// If some keywords are found, mark as in_progress
					if (matchedKeywords.length >= 1) {
						hasInProgress = true;
						return { ...todo, status: "in_progress" as const };
					}
				}
			}

			return todo;
		});

		// If we have completed items but some are still pending, and there are
		// in_progress items, that's fine — the loop continues.
		// If no items are in_progress but some are still pending, mark the first
		// pending as in_progress (assumes sequential execution).
		if (!hasInProgress) {
			const firstPendingIdx = updated.findIndex((t) => t.status === "pending");
			if (firstPendingIdx >= 0) {
				updated[firstPendingIdx] = { ...updated[firstPendingIdx], status: "in_progress" };
			}
		}

		this.#todos = updated;
		return updated;
	}

	get todos(): TodoItem[] {
		return this.#todos;
	}

	// ------------------------------------------------------------------
	// Private helpers
	// ------------------------------------------------------------------

	#uniqueId(base: string, seen: Set<string>): string {
		if (!base) base = "todo";
		if (!seen.has(base)) return base;
		let i = 2;
		while (seen.has(`${base}-${i}`)) i++;
		return `${base}-${i}`;
	}

	/** Extract significant keywords from a todo title for fuzzy matching. */
	#extractKeywords(title: string): string[] {
		return title
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((w) => w.length > 3)
			.filter((w) => !["the", "this", "that", "with", "from", "into", "have", "will", "your", "they", "them", "what", "when", "which", "then"].includes(w));
	}
}
