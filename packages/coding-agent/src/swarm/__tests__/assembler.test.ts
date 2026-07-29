/**
 * assembler.test.ts — Unit tests for assembleAgentRuntime() factory.
 *
 * Covers:
 * - Full assembly with all optional dependencies present
 * - Minimal assembly with all optional dependencies absent
 * - Partial: memory-related deps present, coordination absent
 * - Partial: coordination-related deps present, memory absent
 */

import { describe, expect, test } from "bun:test";

import type { ProfileRegistry } from "../../agent/agent-profile";
import type { RoleAssetManager } from "../../agent/role-asset";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { MarkEnvironment } from "../../coordination";
import type { IrcBus } from "../../irc/bus";
import type { IOffloadManager } from "../../offload/manager";
import type { Tool } from "../../tools";
import { assembleAgentRuntime } from "../core/assembler";
import type { ExperienceStore } from "../curtain/experience";
import type { HookPipeline } from "../hook-system/hook-pipeline";
import type { ActivityLogger } from "../infra/activity-logger";
import type { SwarmHindsightClient } from "../infra/hindsight-adapter";
import type { MnemopiClient } from "../infra/mnemopi-adapter";

// ============================================================================
// Minimal mocks — just enough to satisfy the type checker and assembly logic
// ============================================================================

const mockModelRegistry = { resolveModel: () => ({}) } as unknown as ModelRegistry;
const mockSettings = { model: "test-model" } as unknown as Settings;
const mockActivityLogger = { log: () => {}, streamEvent: () => {} } as unknown as ActivityLogger;
const mockRoleAssetManager = { getRole: () => null } as unknown as RoleAssetManager;
const mockHookPipeline = { register: () => {}, trigger: () => Promise.resolve() } as unknown as HookPipeline;

const mockProfileRegistry = {} as unknown as ProfileRegistry;
const mockIrcBus = { setActivityLogger: () => {}, setHookPipeline: () => {} } as unknown as IrcBus;
const mockToolRegistry = new Map<string, Tool>();
const mockExperienceStore = { getLessons: () => [] } as unknown as ExperienceStore;
const mockHindsightClient = { search: () => Promise.resolve([]) } as unknown as SwarmHindsightClient;
const mockMnemopiClient = { query: () => Promise.resolve([]) } as unknown as MnemopiClient;
const mockMarkEnvironment = {} as MarkEnvironment;
const mockOffloadManager = { offload: () => {} } as unknown as IOffloadManager;
const mockActiveMmd = "graph TD\nA-->B";

// ============================================================================
// Tests
// ============================================================================

describe("assembleAgentRuntime", () => {
	// ── Combo 1: ALL optional dependencies present ────────────────────────

	test("assembles with all optional dependencies present", () => {
		const runtime = assembleAgentRuntime({
			modelRegistry: mockModelRegistry,
			settings: mockSettings,
			activityLogger: mockActivityLogger,
			roleAssetManager: mockRoleAssetManager,
			hookPipeline: mockHookPipeline,
			profileRegistry: mockProfileRegistry,
			ircBus: mockIrcBus,
			toolRegistry: mockToolRegistry,
			experienceStore: mockExperienceStore,
			hindsightClient: mockHindsightClient,
			mnemopiClient: mockMnemopiClient,
			markEnvironment: mockMarkEnvironment,
			offloadManager: mockOffloadManager,
			activeMmd: mockActiveMmd,
		});

		// Verify we got back a valid AgentRuntime (public API surface)
		expect(runtime).toBeTruthy();
		expect(typeof runtime.spawn).toBe("function");
		expect(typeof runtime.spawnRoundtable).toBe("function");
	});

	// ── Combo 2: ALL optional dependencies absent ─────────────────────────

	test("assembles with no optional dependencies", () => {
		const runtime = assembleAgentRuntime({
			modelRegistry: mockModelRegistry,
			settings: mockSettings,
			activityLogger: mockActivityLogger,
			roleAssetManager: mockRoleAssetManager,
			hookPipeline: mockHookPipeline,
		});

		expect(runtime).toBeTruthy();
		expect(typeof runtime.spawn).toBe("function");
	});

	// ── Combo 3: memory-related deps present, coordination absent ────────

	test("assembles with memory deps (experience, mnemopi, hindsight, activeMmd) but no coordination", () => {
		const runtime = assembleAgentRuntime({
			modelRegistry: mockModelRegistry,
			settings: mockSettings,
			activityLogger: mockActivityLogger,
			roleAssetManager: mockRoleAssetManager,
			hookPipeline: mockHookPipeline,
			experienceStore: mockExperienceStore,
			mnemopiClient: mockMnemopiClient,
			hindsightClient: mockHindsightClient,
			activeMmd: mockActiveMmd,
		});

		expect(runtime).toBeTruthy();
		expect(typeof runtime.spawn).toBe("function");
	});

	// ── Combo 4: coordination-related deps present, memory absent ─────────

	test("assembles with coordination deps (ircBus, markEnv, offload, toolRegistry) but no memory", () => {
		const runtime = assembleAgentRuntime({
			modelRegistry: mockModelRegistry,
			settings: mockSettings,
			activityLogger: mockActivityLogger,
			roleAssetManager: mockRoleAssetManager,
			hookPipeline: mockHookPipeline,
			ircBus: mockIrcBus,
			toolRegistry: mockToolRegistry,
			markEnvironment: mockMarkEnvironment,
			offloadManager: mockOffloadManager,
		});

		expect(runtime).toBeTruthy();
		expect(typeof runtime.spawn).toBe("function");
	});
});
