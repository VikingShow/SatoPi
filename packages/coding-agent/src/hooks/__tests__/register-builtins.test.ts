/**
 * register-builtins.test.ts — registerBuiltinHooks() dedup guard (slice H).
 *
 * registerBuiltinHooks is invoked from several bootstrap layers that share one
 * HookPipeline (createOrchestratorRuntime, the swarm-cli session factory,
 * createSwarmSession, SessionRegistry.createSession). Without the
 * registerIfAbsent guard each redundant call re-registers the same builtins
 * and trips HookPipeline's "Overwriting existing hook" warning on startup.
 * These tests pin the first-wins idempotency contract.
 */

import { describe, expect, test } from "bun:test";

import type { ProfileRegistry } from "../../agent/agent-profile";
import type { MarkEnvironment } from "../../coordination";
import type { ExperienceStore } from "../../experience/experience";
import type { IOffloadManager } from "../../offload/manager";
import { HookPipeline } from "../hook-pipeline";
import { registerBuiltinHooks } from "../register-builtins";

// Minimal mocks — the factories only store their dependency, so structural
// stand-ins are sufficient (same pattern as src/swarm/__tests__/assembler.test.ts).
const mockProfileRegistry = {} as unknown as ProfileRegistry;
const mockMarkEnvironment = {} as unknown as MarkEnvironment;
const mockExperienceStore = { getLessons: () => [] } as unknown as ExperienceStore;
const mockOffloadManager = { offload: () => {} } as unknown as IOffloadManager;

const ALL_DEPS = {
	profileRegistry: mockProfileRegistry,
	markEnvironment: mockMarkEnvironment,
	experienceStore: mockExperienceStore,
	offloadManager: mockOffloadManager,
};

describe("registerBuiltinHooks", () => {
	test("registers each builtin once per pipeline", () => {
		const pipeline = new HookPipeline();

		const first = registerBuiltinHooks(pipeline, ALL_DEPS);
		expect([...first].sort()).toEqual(["experience-hook", "offload-hook", "profile-hook", "stigmergy-hook"]);
		expect(pipeline.list()).toHaveLength(4);
	});

	test("is idempotent: a second call with identical deps registers nothing", () => {
		const pipeline = new HookPipeline();
		registerBuiltinHooks(pipeline, ALL_DEPS);

		const second = registerBuiltinHooks(pipeline, ALL_DEPS);
		expect(second).toEqual([]);

		const names = pipeline
			.list()
			.map(h => h.name)
			.sort();
		expect(names).toEqual(["experience-hook", "offload-hook", "profile-hook", "stigmergy-hook"]);
	});

	test("still registers hooks that an earlier call did not provide", () => {
		const pipeline = new HookPipeline();
		registerBuiltinHooks(pipeline, { profileRegistry: mockProfileRegistry });

		const added = registerBuiltinHooks(pipeline, { offloadManager: mockOffloadManager });
		expect(added).toEqual(["offload-hook"]);

		const names = pipeline
			.list()
			.map(h => h.name)
			.sort();
		expect(names).toEqual(["offload-hook", "profile-hook"]);
	});
});
