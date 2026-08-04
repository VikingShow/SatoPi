/**
 * Integration test — P0 lifecycle-event wiring contract, slice B
 * (local/p0-event-wiring-contract.md).
 *
 * Chain under test:
 *
 *   workflow:beforePhase { phase: "stage" }
 *     → offload-hook forceFlush(ctx.phase)
 *     → offload:beforeFlush / offload:afterFlush (ctx.phase = "stage")
 *     → offload:afterFlush payload { entry, runId }
 *     → experience-hook saveLesson → real ExperienceStore (temp dir)
 *
 * Regression guard: if the offload:afterFlush payload is reverted to `{}`
 * the experience-hook skips saveLesson and the store stays empty, failing
 * the "lessons > 0" assertions below.
 */

import { describe, expect, it } from "bun:test";
import { TempDir } from "@satopi/pi-utils";
import { ExperienceStore } from "../../src/experience/experience";
import { createExperienceHook } from "../../src/hooks/builtins/experience-hook";
import { createOffloadHook } from "../../src/hooks/builtins/offload-hook";
import { HookPipeline } from "../../src/hooks/hook-pipeline";
import type { HandlerArgs, HookContext } from "../../src/hooks/types";
import { OffloadManager } from "../../src/offload/manager";
import { MemorySessionStorage } from "../../src/session/store/session-storage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a real pipeline: offload-hook + experience-hook on a real
 * ExperienceStore backed by the given temp dir. Also registers a spy that
 * records the phase delivered with the flush events.
 */
async function setupPipeline(
	tempDir: TempDir,
	sessionId: string,
): Promise<{
	store: ExperienceStore;
	pipeline: HookPipeline;
	manager: OffloadManager;
	seenPhases: Array<string | undefined>;
}> {
	const store = new ExperienceStore(tempDir.path());
	await store.init();

	const pipeline = new HookPipeline();
	const manager = new OffloadManager(tempDir.path(), "test-agent", sessionId, new MemorySessionStorage(), pipeline);

	const seenPhases: Array<string | undefined> = [];
	pipeline.register({
		name: "flush-phase-spy",
		priority: 3, // between offload-hook (2) and experience-hook (4)
		events: ["offload:beforeFlush", "offload:afterFlush"],
		phases: ["stage"],
		handler: async (_args: HandlerArgs, ctx: HookContext) => {
			seenPhases.push(ctx.phase);
		},
	});
	pipeline.register(createOffloadHook(manager));
	pipeline.register(createExperienceHook(store));

	return { store, pipeline, manager, seenPhases };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("experience write chain (workflow:beforePhase → offload:afterFlush → saveLesson)", () => {
	it("bridges the flush payload into the real ExperienceStore with the actual phase", async () => {
		using tempDir = TempDir.createSync("@pi-experience-write-chain-");
		const { store, pipeline, manager, seenPhases } = await setupPipeline(tempDir, "session-1");

		try {
			// Seed one offload entry so the bridged lesson reflects real data.
			await manager.summarizeL1("worker-a1", "Completed auth module refactoring");

			await pipeline.trigger("workflow:beforePhase", { phase: "stage" }, { phase: "stage" });

			// Both flush events must carry the real phase (not undefined).
			expect(seenPhases).toEqual(["stage", "stage"]);

			// The experience store must have persisted the bridged lesson.
			const lessons = store.getRecentLessons(10);
			expect(lessons.length).toBeGreaterThan(0);

			const bridged = lessons[0];
			expect(bridged.runId.startsWith("session-1-")).toBe(true);
			expect(bridged.runId.length).toBeGreaterThan("session-1-".length);
			expect(bridged.lesson.type).toBe("reflection");
			expect(bridged.lesson.summary).toBe("Completed auth module refactoring");
			expect(bridged.lesson.source).toBe("offload-flush");
			expect(bridged.stats.totalIterations).toBe(1);
			expect(bridged.stats.finalStatus).toBe("completed");
		} finally {
			store.close();
		}
	});

	it("falls back to a default summary when the session has no offload entries", async () => {
		using tempDir = TempDir.createSync("@pi-experience-write-chain-empty-");
		const { store, pipeline } = await setupPipeline(tempDir, "session-2");

		try {
			await pipeline.trigger("workflow:beforePhase", { phase: "stage" }, { phase: "stage" });

			const lessons = store.getRecentLessons(10);
			expect(lessons.length).toBeGreaterThan(0);
			expect(lessons[0].lesson.summary).toBe("swarm run flush");
			expect(lessons[0].stats.totalIterations).toBe(0);
		} finally {
			store.close();
		}
	});

	it("keeps roundtable:afterRound L1 summarization working alongside the flush payload", async () => {
		using tempDir = TempDir.createSync("@pi-experience-write-chain-roundtable-");
		const { store, pipeline } = await setupPipeline(tempDir, "session-3");

		try {
			// The roundtable handler must still run summarizeL1 without error.
			await pipeline.trigger(
				"roundtable:afterRound",
				{ agentId: "worker-a1" },
				{ phase: "stage", agentId: "worker-a1" },
			);

			// The L1 entry is written through to the session file and picked up by a
			// subsequent flush — the roundtable path is unbroken by the payload change.
			await pipeline.trigger("workflow:beforePhase", { phase: "stage" }, { phase: "stage" });

			const lessons = store.getRecentLessons(10);
			expect(lessons.length).toBeGreaterThan(0);
			expect(lessons[0].lesson.source).toBe("offload-flush");
			expect(lessons[0].lesson.summary).toBe("(object with keys: agentId)");
			expect(lessons[0].stats.totalIterations).toBe(1);
		} finally {
			store.close();
		}
	});
});
