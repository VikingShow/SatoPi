/**
 * LessonSink unit tests — verifies fail-soft fan-out to multiple backends.
 */

import { describe, expect, it } from "bun:test";
import type { ExperienceStore } from "../../experience/experience";
import type { ExtractedLesson, LoopRunStats } from "../../experience/extractor";
import { MultiLessonSink } from "../curtain/lesson-sink";
import type { SwarmHindsightClient } from "../infra/hindsight-adapter";
import type { MnemopiClient } from "../infra/mnemopi-adapter";

const STATS: LoopRunStats = {
	totalIterations: 3,
	finalStatus: "completed",
	reviewApprovalRatio: 0.8,
	agentCount: 4,
	taskDescription: "add caching",
};

const LESSONS: ExtractedLesson[] = [
	{
		type: "insight",
		summary: "use LRU",
		detail: "LRU beat TTL",
		tags: ["cache"],
		confidence: 0.9,
		source: "reflector",
	},
	{ type: "error", summary: "race", detail: "invalidation race", tags: ["bug"], confidence: 0.7, source: "extractor" },
];

/** Minimal ExperienceStore stub capturing saveLesson calls. */
function fakeStore(): { store: ExperienceStore; saved: Array<{ runId: string }> } {
	const saved: Array<{ runId: string }> = [];
	const store = {
		saveLesson: (entry: { runId: string }) => {
			saved.push(entry);
		},
	} as unknown as ExperienceStore;
	return { store, saved };
}

describe("MultiLessonSink", () => {
	it("saves every lesson to the ExperienceStore with the runId-type convention", async () => {
		const { store, saved } = fakeStore();
		const sink = MultiLessonSink.create({ experienceStore: store });
		await sink.fanOut(LESSONS, STATS, "run-1");
		expect(saved.map(s => s.runId)).toEqual(["run-1-insight", "run-1-error"]);
	});

	it("is a no-op for an empty lesson batch", async () => {
		const { store, saved } = fakeStore();
		const sink = MultiLessonSink.create({ experienceStore: store });
		await sink.fanOut([], STATS, "run-1");
		expect(saved).toHaveLength(0);
	});

	it("fans out to Hindsight when a client is provided", async () => {
		const { store } = fakeStore();
		let retained: number | undefined;
		const hindsightClient: SwarmHindsightClient = {
			recall: async () => [],
			retainLessons: async items => {
				retained = items.length;
			},
		};
		const sink = MultiLessonSink.create({ experienceStore: store, hindsightClient });
		await sink.fanOut(LESSONS, STATS, "run-1");
		expect(retained).toBe(2);
	});

	it("isolates a failing sink: ExperienceStore still saves and fanOut resolves", async () => {
		const { store, saved } = fakeStore();
		const hindsightClient: SwarmHindsightClient = {
			recall: async () => [],
			retainLessons: async () => {
				throw new Error("hindsight 500");
			},
		};
		const sink = MultiLessonSink.create({ experienceStore: store, hindsightClient });
		// Must not throw despite the Hindsight sink rejecting.
		await expect(sink.fanOut(LESSONS, STATS, "run-1")).resolves.toBeUndefined();
		expect(saved).toHaveLength(2);
	});

	it("fans out to Mnemopi when a client is provided", async () => {
		const { store } = fakeStore();
		const remembered: string[] = [];
		const mnemopiClient: MnemopiClient = {
			recall: async () => [],
			remember: async content => {
				remembered.push(content);
			},
		};
		const sink = MultiLessonSink.create({ experienceStore: store, mnemopiClient });
		await sink.fanOut(LESSONS, STATS, "run-1");
		expect(remembered).toEqual(["LRU beat TTL", "invalidation race"]);
	});
});
