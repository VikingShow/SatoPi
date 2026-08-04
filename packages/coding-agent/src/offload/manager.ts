/**
 * OffloadManager — unified interface for the offload subsystem.
 *
 * Combines two previously separate interfaces:
 *   1. hook-system/builtins/offload-hook.ts — summarizeL1 / forceFlush (hook direction)
 *   2. context-manager/sources/offload-source.ts — getMmdContext / getExperienceContext (context direction)
 *
 * A single instance is passed to both the HookPipeline (via registerBuiltinHooks)
 * and the ContextPipeline (via OffloadSource), so the summarize→store→inject
 * pipeline is closed.
 */

import { logger } from "@satopi/pi-utils";
import type { ExperienceEntry } from "../experience/experience";
import type { HookPipeline } from "../hooks/hook-pipeline";
import type { HookContext } from "../hooks/types";
import type { SessionStorage } from "../session/store/session-storage";
import type { Chapter } from "../types/chapter";
import type { OffloadCompactStatus } from "./compact";
import { type OffloadEntry, OffloadStore } from "./store";

// ---------------------------------------------------------------------------
// Unified interface
// ---------------------------------------------------------------------------

export interface IOffloadManager {
	/** L1 summarization of an agent's output (hook direction). */
	summarizeL1(agentId: string, content: unknown): Promise<void>;
	/** Force-flush pending offload data to persistent storage (hook direction). */
	forceFlush(phase?: Chapter): Promise<void>;
	/** Get MMD context for agent spawn injection (context direction). */
	getMmdContext(agentId: string, taskDescription: string): Promise<string | null>;
	/** Get experience context for agent spawn injection (context direction). */
	getExperienceContext(agentId: string, taskDescription: string): Promise<string | null>;
	/** Get a map of agent_id → latest summary for all offloaded agents. */
	getOffloadSummaries(): Promise<Map<string, string>>;
	/**
	 * Record the outcome of an L3 `compactContext` run (offload → session
	 * coordination signal). Called by the per-request L3 transform callers.
	 */
	recordCompactResult(status: OffloadCompactStatus): void;
	/** Last recorded L3 compaction outcome, or undefined when L3 never ran. */
	getLastCompactStatus(): OffloadCompactStatus | undefined;
}
// ---------------------------------------------------------------------------

export class OffloadManager implements IOffloadManager {
	readonly #store: OffloadStore;
	readonly #sessionId: string;
	readonly #hookPipeline: HookPipeline | undefined;
	#iteration = 0;
	/** Outcome of the most recent L3 compactContext run (session-coordination signal). */
	#lastCompactStatus: OffloadCompactStatus | undefined;

	constructor(
		workspace: string,
		agentName: string,
		sessionId: string,
		storage: SessionStorage,
		hookPipeline?: HookPipeline,
	) {
		this.#store = new OffloadStore(workspace, agentName, storage);
		this.#sessionId = sessionId;
		this.#hookPipeline = hookPipeline;
	}

	/** Set the current iteration for entry tagging. */
	setIteration(it: number): void {
		this.#iteration = it;
	}

	// -- Hook direction --------------------------------------------------------

	async summarizeL1(agentId: string, content: unknown): Promise<void> {
		// Extract a summary from the content (could be SingleResult, string, or arbitrary payload)
		const summary = extractSummary(content);
		const taskCall = extractTaskCall(content);

		const entry: OffloadEntry = {
			timestamp: new Date().toISOString(),
			agent_id: agentId,
			iteration: this.#iteration,
			task_call: taskCall,
			summary,
			score: 5, // neutral default; refined by reviewer verdicts later
		};

		await this.#store.appendEntry(agentId, this.#sessionId, entry);
		logger.debug("[OffloadManager] L1 entry stored", { agentId, summaryLen: summary.length });

		// Hook: offload:afterL1
		if (this.#hookPipeline) {
			const ctx: HookContext = { phase: undefined, agentId };
			await this.#hookPipeline.trigger("offload:afterL1", { agentId }, ctx);
		}
	}

	async forceFlush(phase?: Chapter): Promise<void> {
		// Hook: offload:beforeFlush
		if (this.#hookPipeline) {
			const ctx: HookContext = { phase };
			await this.#hookPipeline.trigger("offload:beforeFlush", {}, ctx);
		}

		// The store is write-through (JSONL append), so no buffered data to flush.
		// L2 attribution (PlanNodeAttributor) is triggered separately when phase
		// boundaries and plan.md are available. This method ensures any pending
		// writes are visible.
		logger.debug("[OffloadManager] forceFlush (write-through, no buffered data)");

		// Bridge this session's offload data to the experience store so the
		// experience-hook can persist a lesson for cross-run learning. The runId
		// is unique per flush: lessons.run_id is the PRIMARY KEY, and a fixed
		// sessionId would collide across stage/curtain flushes — the later flush
		// (carrying the real L1 summary) would be silently dropped.
		const sessionEntries = await this.#store.readAllFileEntries(this.#sessionId);
		const latest = sessionEntries[sessionEntries.length - 1];
		const runId = `${this.#sessionId}-${Date.now()}`;
		const entry: ExperienceEntry = {
			runId,
			timestamp: new Date().toISOString(),
			lesson: {
				type: "reflection",
				summary: latest?.summary ?? "swarm run flush",
				detail: "",
				tags: [],
				confidence: 0.5,
				source: "offload-flush",
			},
			stats: {
				totalIterations: sessionEntries.length,
				finalStatus: "completed",
				reviewApprovalRatio: 0,
				agentCount: 0,
			},
		};

		// Hook: offload:afterFlush
		if (this.#hookPipeline) {
			const ctx: HookContext = { phase };
			await this.#hookPipeline.trigger("offload:afterFlush", { entry, runId }, ctx);
		}
	}

	async getOffloadSummaries(): Promise<Map<string, string>> {
		const entries = await this.#store.readAllEntries();
		const map = new Map<string, string>();
		// Later entries for the same agent_id overwrite earlier ones (latest wins)
		for (const e of entries) {
			map.set(e.agent_id, e.summary);
		}
		return map;
	}

	// -- Session-compaction coordination --------------------------------------

	recordCompactResult(status: OffloadCompactStatus): void {
		this.#lastCompactStatus = status;
	}

	getLastCompactStatus(): OffloadCompactStatus | undefined {
		return this.#lastCompactStatus;
	}

	// -- Context direction -----------------------------------------------------

	async getMmdContext(agentId: string, taskDescription: string): Promise<string | null> {
		const entries = await this.#store.readEntries(agentId, this.#sessionId);
		if (entries.length === 0) return null;

		const recent = entries.slice(-5); // last 5 entries
		const lines = [
			"<offload_context>",
			`  Agent ${agentId} has completed ${entries.length} tasks so far.`,
			`  Recent work for task "${taskDescription}":`,
			"",
			...recent.map(e => `  - [${e.timestamp}] ${e.task_call}: ${e.summary.slice(0, 150)}`),
			"</offload_context>",
		];

		return lines.join("\n");
	}

	async getExperienceContext(agentId: string, taskDescription: string): Promise<string | null> {
		// Read all agents' entries to provide cross-agent experience
		const allEntries = await this.#store.readAllEntries();
		if (allEntries.length === 0) return null;

		// Group by agent and pick top entries
		const byAgent = new Map<string, OffloadEntry[]>();
		for (const e of allEntries) {
			const list = byAgent.get(e.agent_id) ?? [];
			list.push(e);
			byAgent.set(e.agent_id, list);
		}

		const lines = [
			"<swarm_experience>",
			`  Prior work across ${byAgent.size} agents for task "${taskDescription}":`,
			"",
		];

		for (const [aid, entries] of byAgent) {
			const latest = entries[entries.length - 1];
			lines.push(
				`  ${aid === agentId ? "* (you)" : `  - ${aid}`}: ${latest.summary.slice(0, 120)} (${entries.length} total entries)`,
			);
		}

		lines.push("</swarm_experience>");
		return lines.join("\n");
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSummary(content: unknown): string {
	if (!content) return "(no output)";
	if (typeof content === "string") return content.slice(0, 200);
	if (typeof content === "object" && content !== null) {
		const obj = content as Record<string, unknown>;
		// SingleResult-like: extract text content
		if (typeof obj.text === "string") return obj.text.slice(0, 200);
		if (typeof obj.summary === "string") return obj.summary.slice(0, 200);
		if (typeof obj.message === "string") return obj.message.slice(0, 200);
		// Fallback: stringify keys
		const keys = Object.keys(obj).join(", ");
		return `(object with keys: ${keys})`;
	}
	return String(content).slice(0, 200);
}

function extractTaskCall(content: unknown): string {
	if (!content) return "(unknown)";
	if (typeof content === "string") return content.slice(0, 80);
	if (typeof content === "object" && content !== null) {
		const obj = content as Record<string, unknown>;
		if (typeof obj.task === "string") return obj.task.slice(0, 80);
		if (typeof obj.taskCall === "string") return obj.taskCall.slice(0, 80);
	}
	return "(see offload entry)";
}
