/**
 * Integration test — Slice G memory coordination contract
 * (local/p1-p3-batch-contract.md, section G).
 *
 * Chain under test:
 *
 *   agent:afterComplete { summary, score }
 *     → mnemopi-hook (createMnemopiHook with coordination deps)
 *       → SwarmMnemopiAdapter.storeAfterIteration → MnemopiClient.remember
 *       → ExperienceStore.saveLesson (real SQLite store, temp dir)
 *       → memories.save → saveLearnedLesson → learned.md (temp memory root)
 *
 * Regression guard: if the hook stops fanning the completion summary out to
 * any of the three memory systems, the matching per-system assertion fails —
 * the mnemopi client never remembers, the experience store stays empty, or
 * learned.md is missing the summary.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@satopi/pi-utils";
import { ExperienceStore } from "../../src/experience/experience";
import { createMnemopiHook } from "../../src/hooks/builtins/mnemopi-hook";
import { HookPipeline } from "../../src/hooks/hook-pipeline";
import { getMemoryRoot, saveLearnedLesson } from "../../src/memories";
import type { MnemopiClient } from "../../src/swarm/infra/mnemopi-adapter";
import { SwarmMnemopiAdapter } from "../../src/swarm/infra/mnemopi-adapter";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RememberedCall {
	content: string;
	metadata?: Record<string, unknown>;
}

/** A recording MnemopiClient — the seam between the adapter and the real store. */
function createRecordingMnemopiClient(): { client: MnemopiClient; remembered: RememberedCall[] } {
	const remembered: RememberedCall[] = [];
	return {
		remembered,
		client: {
			async recall() {
				return [];
			},
			async remember(content: string, metadata?: Record<string, unknown>) {
				remembered.push({ content, metadata });
			},
		},
	};
}

interface Setup {
	store: ExperienceStore;
	pipeline: HookPipeline;
	remembered: RememberedCall[];
	learnedPath: string;
}

/**
 * Build a real pipeline: mnemopi-hook with all three coordination sinks —
 * a real SwarmMnemopiAdapter over a recording client, a real
 * ExperienceStore (temp dir), and the real memories `learned.md` ingest
 * bound to a temp agent dir / cwd.
 */
async function setupPipeline(tempDir: TempDir): Promise<Setup> {
	const agentDir = path.join(tempDir.path(), "agent");
	const cwd = path.join(tempDir.path(), "project");
	await fs.mkdir(getMemoryRoot(agentDir, cwd), { recursive: true });

	const { client, remembered } = createRecordingMnemopiClient();
	const adapter = new SwarmMnemopiAdapter(client, {
		enabled: true,
		topK: 5,
		deduplicate: true,
		autoStoreThreshold: 5,
	});

	const store = new ExperienceStore(tempDir.path());
	await store.init();

	const pipeline = new HookPipeline();
	pipeline.register(
		createMnemopiHook(adapter, {
			experienceStore: store,
			memories: {
				async save(input) {
					return saveLearnedLesson(agentDir, cwd, typeof input === "string" ? { content: input } : input);
				},
			},
		}),
	);

	return { store, pipeline, remembered, learnedPath: path.join(getMemoryRoot(agentDir, cwd), "learned.md") };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memory coordination (agent:afterComplete → mnemopi + ExperienceStore + memories)", () => {
	it("fans one completion summary out to all three memory systems", async () => {
		using tempDir = TempDir.createSync("@pi-memory-coordination-");
		const { store, pipeline, remembered, learnedPath } = await setupPipeline(tempDir);

		try {
			await pipeline.trigger(
				"agent:afterComplete",
				{
					agentId: "worker-a1",
					success: true,
					summary: "Completed auth module refactoring",
					score: 8,
					message: "auth module done",
					taskId: "task-1",
				},
				{ phase: "stage", agentId: "worker-a1" },
			);

			// 1. mnemopi — the adapter pushed the summary through to the client.
			expect(remembered).toHaveLength(1);
			expect(remembered[0].content).toBe("Completed auth module refactoring");

			// 2. ExperienceStore — the lesson row was persisted.
			const lessons = store.getRecentLessons(10);
			expect(lessons.length).toBe(1);
			expect(lessons[0].lesson.summary).toBe("Completed auth module refactoring");
			expect(lessons[0].lesson.source).toBe("agent:afterComplete");
			expect(lessons[0].lesson.type).toBe("reflection");
			expect(lessons[0].stats.finalStatus).toBe("completed");
			expect(lessons[0].nodeId).toBe("worker-a1");

			// 3. memories — learned.md captured the same summary.
			const learned = await fs.readFile(learnedPath, "utf8");
			expect(learned).toContain("Completed auth module refactoring");
		} finally {
			store.close();
		}
	});

	it("marks failures in both stores without losing the summary", async () => {
		using tempDir = TempDir.createSync("@pi-memory-coordination-failure-");
		const { store, pipeline, remembered, learnedPath } = await setupPipeline(tempDir);

		try {
			await pipeline.trigger(
				"agent:afterComplete",
				{
					agentId: "worker-b2",
					success: false,
					summary: "provider rate limit exceeded",
					score: 8,
				},
				{ phase: "stage", agentId: "worker-b2" },
			);

			expect(remembered).toHaveLength(1);
			expect(remembered[0].content).toBe("provider rate limit exceeded");

			const lessons = store.getRecentLessons(10);
			expect(lessons.length).toBe(1);
			expect(lessons[0].lesson.summary).toBe("provider rate limit exceeded");
			expect(lessons[0].lesson.type).toBe("error");
			expect(lessons[0].stats.finalStatus).toBe("failed");

			const learned = await fs.readFile(learnedPath, "utf8");
			expect(learned).toContain("provider rate limit exceeded");
		} finally {
			store.close();
		}
	});

	it("stays mnemopi-only and crash-free when no coordination sinks are wired", async () => {
		const { client, remembered } = createRecordingMnemopiClient();
		const adapter = new SwarmMnemopiAdapter(client, {
			enabled: true,
			topK: 5,
			deduplicate: true,
			autoStoreThreshold: 5,
		});

		const pipeline = new HookPipeline();
		pipeline.register(createMnemopiHook(adapter));

		await pipeline.trigger(
			"agent:afterComplete",
			{ agentId: "worker-c3", success: true, summary: "bare summary", score: 8 },
			{ phase: "stage", agentId: "worker-c3" },
		);

		// mnemopi still consumes the event…
		expect(remembered).toHaveLength(1);
		expect(remembered[0].content).toBe("bare summary");
		// …and the un-wired systems are simply not touched (no throw).
	});
});
