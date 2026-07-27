/**
 * HindsightSource unit tests — verifies fail-soft recall → context injection.
 */

import { describe, expect, it } from "bun:test";
import type { AgentSpecLike, BuildContext, PhaseInfo } from "../context-manager/context-pipeline";
import { HindsightSource } from "../context-manager/sources/hindsight-source";
import type { HindsightRecallItem, SwarmHindsightClient } from "../infra/hindsight-adapter";

const PHASE: PhaseInfo = { phase: "stage", multiAgent: true, humanMode: "observer" };
const SPEC: AgentSpecLike = { id: "a1", role: "worker", task: "add caching" };

function baseCtx(task = "add caching"): BuildContext {
	return {
		taskDescription: task,
		workspace: "/tmp/ws",
		swarmDir: "/tmp/ws/.stp",
		turnNumber: 0,
		phase: PHASE,
		accumulated: {},
	};
}

function mockClient(impl: Partial<SwarmHindsightClient>): SwarmHindsightClient {
	return {
		recall: impl.recall ?? (async () => []),
		retainLessons: impl.retainLessons ?? (async () => {}),
	};
}

describe("HindsightSource", () => {
	it("is inactive when no client is configured", async () => {
		const src = new HindsightSource(null);
		expect(src.appliesTo("stage", "worker")).toBe(false);
		expect(await src.build(SPEC, baseCtx())).toEqual({});
	});

	it("applies to all phases when a client is present", () => {
		const src = new HindsightSource(mockClient({}));
		expect(src.appliesTo("stage", "worker")).toBe(true);
		expect(src.appliesTo("script", "planner")).toBe(true);
		expect(src.appliesTo("curtain", "reporter")).toBe(true);
	});

	it("injects a <hindsight_memories> message when recall returns results", async () => {
		const items: HindsightRecallItem[] = [
			{ text: "Prefer LRU over TTL for hot paths", type: "insight" },
			{ text: "Cache invalidation caused a prod bug once", type: "warning" },
		];
		const src = new HindsightSource(mockClient({ recall: async () => items }));
		const frag = await src.build(SPEC, baseCtx());
		expect(frag.injectedMessages).toHaveLength(1);
		const content = (frag.injectedMessages![0] as { content: string }).content;
		expect(content).toContain("<hindsight_memories>");
		expect(content).toContain("Prefer LRU over TTL");
		expect(content).toContain("(insight)");
	});

	it("returns an empty fragment when recall yields nothing", async () => {
		const src = new HindsightSource(mockClient({ recall: async () => [] }));
		expect(await src.build(SPEC, baseCtx())).toEqual({});
	});

	it("is fail-soft: a throwing recall yields an empty fragment, never rejects", async () => {
		const src = new HindsightSource(
			mockClient({
				recall: async () => {
					throw new Error("network down");
				},
			}),
		);
		await expect(src.build(SPEC, baseCtx())).resolves.toEqual({});
	});

	it("passes an abort signal to recall (timeout wiring)", async () => {
		let sawSignal = false;
		const src = new HindsightSource(
			mockClient({
				recall: async (_q, opts) => {
					sawSignal = opts?.signal instanceof AbortSignal;
					return [];
				},
			}),
		);
		await src.build(SPEC, baseCtx());
		expect(sawSignal).toBe(true);
	});
});
