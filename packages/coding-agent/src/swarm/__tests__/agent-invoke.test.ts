/**
 * agent-invoke.test.ts — E2E tests for agent_invoke tool integration with AgentRuntime.
 *
 * Verifies:
 * - AgentRuntime flows through ToolContextStore to agent_invoke tool context
 * - agent_invoke calls runtime.spawn() with correct AgentSpec
 * - Error message when no agentRuntime is available
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "../../registry/agent-registry";
import type { Tool } from "../../tools";
import { agentInvokeTool } from "../../tools/agent-invoke";
import { ToolContextStore } from "../../tools/context";
import type { RoleAsset, RoleAssetManager } from "../agent/role-asset";
import type { AgentHandle } from "../agent-runtime/agent-handle";
import { AgentLauncher } from "../agent-runtime/agent-launcher";
import { AgentRuntime } from "../agent-runtime/index";
import { RoleProvider } from "../agent-runtime/role-provider";
import { CommBus } from "../comm-bus/comm-bus";
import { ContextPipeline } from "../context-manager/context-pipeline";
import { HookPipeline } from "../hook-system/hook-pipeline";

// ============================================================================
// Mock session factory for AgentLauncher (avoids pulling in full SDK)
// ============================================================================

const mockSession = {
	agent: {
		setAsideMessageProvider: () => {},
		subscribe: () => () => {},
		prompt: async () => {},
		steer: () => {},
		followUp: () => {},
	},
	prompt: async () => {},
	setToolContextAgentRuntime: () => {},
};

const mockSessionFactory = async () => ({
	session: mockSession as unknown as import("../../session/agent-session").AgentSession,
});

// ============================================================================
// Helpers
// ============================================================================

/** Create a minimal role asset for testing. */
function makeRoleAsset(overrides?: Partial<RoleAsset>): RoleAsset {
	return {
		id: "planner",
		name: "Planner",
		description: "Test planner role",
		version: 1,
		author: "test",
		status: "approved",
		prompts: {
			system: "You are a planner agent.",
			guidelines: ["Plan carefully", "Ask questions"],
		},
		tools: ["read", "write", "grep"],
		tags: ["planning"],
		created_at: "2025-01-01T00:00:00Z",
		updated_at: "2025-01-01T00:00:00Z",
		usage_count: 0,
		success_rate: 1.0,
		...overrides,
	};
}

/** Create a mock RoleAssetManager. */
function mockRoleAssetManager(roles: Record<string, RoleAsset | null> = {}): RoleAssetManager {
	return {
		get: async (id: string) => roles[id] ?? null,
		init: async () => {},
		list: async () => [],
		search: async () => [],
		create: async () => ({}) as RoleAsset,
		update: async () => ({}) as RoleAsset,
		approve: async () => ({}) as RoleAsset,
		deprecate: async () => ({}) as RoleAsset,
		recordUsage: async () => {},
		delete: async () => false,
		seedIfEmpty: async () => 0,
		get rolesDir() {
			return "";
		},
	} as unknown as RoleAssetManager;
}

/** Build a minimal AgentRuntime with mocked launcher for testing. */
function makeAgentRuntime(): AgentRuntime {
	const roleMgr = mockRoleAssetManager({
		planner: makeRoleAsset({ id: "planner" }),
	});
	const roleProvider = new RoleProvider(roleMgr);
	const contextPipeline = new ContextPipeline();
	const hookPipeline = new HookPipeline();
	const commBus = new CommBus();

	const mockTool = { name: "mock", execute: async () => ({ output: "ok" }) } as unknown as Tool;
	const toolRegistry = new Map<string, Tool>([
		["read", mockTool],
		["grep", mockTool],
		["write", mockTool],
		["bash", mockTool],
		["glob", mockTool],
	]);

	const modelRegistry = {
		getAvailable: () => [{ id: "test-model", provider: "test", supportsTools: true }],
		resolver: async () => undefined,
		find: () => ({ id: "test-model", provider: "test" }),
	} as unknown as ModelRegistry;

	const settings = {} as Settings;

	const launcher = new AgentLauncher(modelRegistry, settings, mockSessionFactory);

	return new AgentRuntime({
		roleProvider,
		contextPipeline,
		launcher,
		commBus,
		hookPipeline,
		modelRegistry,
		settings,
		toolRegistry,
	});
}

/** Create a ToolContextStore for testing with optional AgentRuntime. */
function makeToolContextStore(agentRuntime?: AgentRuntime): ToolContextStore {
	const store = new ToolContextStore(() => ({
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
		autoApprove: false,
	}));
	if (agentRuntime) {
		store.setAgentRuntime(agentRuntime);
	}
	return store;
}

// ============================================================================
// Cleanup
// ============================================================================

beforeEach(() => {
	// Clear AgentRegistry global state to prevent cross-test leakage.
	// The global singleton persists across tests; unregister any lingering refs.
	const registry = AgentRegistry.global();
	for (const ref of registry.list()) {
		registry.unregister(ref.id);
	}
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ============================================================================
// Tests
// ============================================================================

describe("agent_invoke E2E", () => {
	describe("AgentRuntime in tool context", () => {
		it("agentRuntime is accessible via ToolContextStore.getContext()", () => {
			const runtime = makeAgentRuntime();
			const store = makeToolContextStore(runtime);

			const ctx: AgentToolContext = store.getContext();

			expect(ctx.agentRuntime).toBe(runtime);
		});

		it("agentRuntime is undefined when not set on ToolContextStore", () => {
			const store = makeToolContextStore(); // no runtime

			const ctx: AgentToolContext = store.getContext();

			expect(ctx.agentRuntime).toBeUndefined();
		});
	});

	describe("agent_invoke with valid profileId", () => {
		it("calls runtime.spawn() with correct AgentSpec", async () => {
			const runtime = makeAgentRuntime();
			const store = makeToolContextStore(runtime);
			const ctx = store.getContext();

			// Mock spawn to verify call without executing real agent launch
			const mockHandle = {
				id: "persist-testProfile",
				wait: vi.fn().mockResolvedValue({ output: "Task completed", exitCode: 0 }),
			};
			const spawnSpy = vi.spyOn(runtime, "spawn").mockResolvedValue([mockHandle as unknown as AgentHandle]);

			const result = await agentInvokeTool.execute(
				"toolCall-1",
				{ profileId: "testProfile", task: "Build the API endpoint" },
				undefined, // signal
				undefined, // onUpdate
				ctx,
			);

			// Verify spawn was called with the correct spec
			expect(spawnSpy).toHaveBeenCalledTimes(1);
			expect(spawnSpy).toHaveBeenCalledWith([
				{
					id: "persist-testProfile",
					role: "persistent",
					roleSource: "library",
					task: "Build the API endpoint",
					profileId: "testProfile",
				},
			]);

			// Verify the tool returns the agent's output
			expect(result.isError).toBe(false);
			expect(result.content).toEqual([{ type: "text", text: "Task completed" }]);
		});

		it("returns error when spawn returns no handles", async () => {
			const runtime = makeAgentRuntime();
			const store = makeToolContextStore(runtime);
			const ctx = store.getContext();

			vi.spyOn(runtime, "spawn").mockResolvedValue([]);

			const result = await agentInvokeTool.execute(
				"toolCall-1",
				{ profileId: "missingHandle", task: "Test task" },
				undefined,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			expect(result.content).toEqual([{ type: "text", text: "agent_invoke: Spawn returned no handles." }]);
		});

		it("returns error when spawn throws", async () => {
			const runtime = makeAgentRuntime();
			const store = makeToolContextStore(runtime);
			const ctx = store.getContext();

			vi.spyOn(runtime, "spawn").mockRejectedValue(new Error("Launch failed: no model"));

			const result = await agentInvokeTool.execute(
				"toolCall-1",
				{ profileId: "crashing", task: "Test task" },
				undefined,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			expect(result.content?.[0]).toEqual({
				type: "text",
				text: "agent_invoke failed: Launch failed: no model",
			});
		});
	});

	describe("agent_invoke without AgentRuntime", () => {
		it("returns improved error message when no agentRuntime is in context", async () => {
			const store = makeToolContextStore(); // no runtime
			const ctx = store.getContext();

			const result = await agentInvokeTool.execute(
				"toolCall-1",
				{ profileId: "anyProfile", task: "Test task" },
				undefined,
				undefined,
				ctx,
			);

			expect(result.isError).toBe(true);
			expect(result.content).toEqual([
				{
					type: "text",
					text: "agent_invoke requires a swarm session with AgentRuntime. Use this tool within a swarm-managed session.",
				},
			]);
		});
	});

	describe("AgentRuntime wiring through createAgentSession pattern", () => {
		it("setToolContextAgentRuntime wires runtime into ToolContextStore", () => {
			// This tests the same wiring path that createAgentSession uses:
			//   session._registerToolContextRuntimeSetter(r => store.setAgentRuntime(r))
			//   session.setToolContextAgentRuntime(runtime)
			const runtime = makeAgentRuntime();
			const store = makeToolContextStore();

			// Simulate the setter registration done by createAgentSession
			const setter = (r: unknown) => store.setAgentRuntime(r as AgentRuntime);
			setter(runtime);

			const ctx = store.getContext();
			expect(ctx.agentRuntime).toBe(runtime);
		});

		it("setter with undefined clears the runtime", () => {
			const runtime = makeAgentRuntime();
			const store = makeToolContextStore(runtime);

			expect(store.getContext().agentRuntime).toBe(runtime);

			// Simulate clearing the runtime
			store.setAgentRuntime(undefined);

			expect(store.getContext().agentRuntime).toBeUndefined();
		});
	});
});
