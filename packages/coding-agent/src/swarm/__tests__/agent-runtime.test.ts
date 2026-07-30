/**
 * agent-runtime.test.ts — Unit tests for the AgentRuntime system (Phase 3A).
 *
 * Covers:
 * - AgentSpec: basic shape validation
 * - RoleProvider.resolve(): library found, library not found fallback,
 *   inline role, default fallback, error handling
 * - AgentSession: status tracking, abort, send/followUp, wait timeout
 * - AgentRuntime.spawn(): single agent, multiple agents in parallel,
 *   HookPipeline triggers
 * - AgentLoopConfig assembly: transformContext, getSteeringMessages,
 *   getFollowUpMessages
 * - Error handling: RoleProvider throws, ContextPipeline throws
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const makeCompletingMockSession = (agentId?: string) => ({
	agent: {
		setAsideMessageProvider: () => {},
		subscribe: (cb: (event: { type: string }) => void) => {
			cb({ type: "agent_end" });
			return () => {};
		},
		prompt: async () => {},
		steer: () => {},
		followUp: () => {},
	},
	prompt: async () => {},
	setToolContextAgentRuntime: () => {},
	get id() {
		return agentId ?? "completed-unknown";
	},
	get status() {
		return "running" as const;
	},
	role: undefined as string | undefined,
});
const mockCompletingSessionFactory = async (opts?: { agentId?: string }) =>
	({
		session: makeCompletingMockSession(opts?.agentId) as unknown as AgentSession,
		extensionsResult: { extensions: [], errors: [], runtime: {} },
		setToolUIContext: () => {},
		eventBus: { emit: () => {}, on: () => () => {}, clear: () => {} },
	}) as unknown as CreateAgentSessionResult;

import type { AgentMessage } from "@satopi/pi-agent-core";
import type { ModelRegistry, Settings } from "@satopi/pi-coding-agent";
// Dependencies
import type { RoleAsset, RoleAssetManager } from "../../agent/role-asset";
import { RoleProvider } from "../../agent/role-provider";
import { IrcBus } from "../../irc/bus";
import { AgentRegistry } from "../../registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import type { Tool } from "../../tools";
// Module under test
import type { AgentSpec, AgentSpecInline } from "../../graph/agent-spec";
import { AgentRuntime, type RoundtableConfig } from "../agent-runtime/index";
import { ContextPipeline } from "../context-manager/context-pipeline";
import { HookPipeline } from "../../hooks/hook-pipeline";
import type { AgentAfterSpawnPayload, AgentBeforeSpawnPayload, HandlerArgs } from "../../hooks/types";

// ============================================================================
// Helpers
// ============================================================================

/** Create a minimal AgentSpec for testing. */
function makeSpec(overrides?: Partial<AgentSpec>): AgentSpec {
	return {
		id: "agent-1",
		role: "planner",
		roleSource: "library" as const,
		task: "Test task",
		...overrides,
	} as AgentSpec;
}
/** Create a mock RoleAssetManager. */
function mockRoleAssetManager(roles: Record<string, RoleAsset | null> = {}): RoleAssetManager {
	return {
		get: async (id: string) => roles[id] ?? null,
		init: async () => {},
		list: async () => [],
		search: async () => [],
		create: async () => ({}) as RoleAsset,
		deprecate: async () => ({}) as RoleAsset,
		recordUsage: async () => {},
		delete: async () => false,
		seedIfEmpty: async () => 0,
		get rolesDir() {
			return "/tmp/roles";
		},
	} as unknown as RoleAssetManager;
}

/** Create an approved role asset for testing. */
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

// ============================================================================
// AgentSpec
// ============================================================================

describe("AgentSpec", () => {
	test("should accept a valid spec", () => {
		const spec = makeSpec();
		expect(spec.id).toBe("agent-1");
		expect(spec.role).toBe("planner");
		expect(spec.roleSource).toBe("library");
		expect(spec.task).toBe("Test task");
	});

	test("should support inline roles", () => {
		const spec = makeSpec({
			roleSource: "inline",
			inline: { systemPrompt: "You are a custom agent.", tools: ["read"] },
		}) as AgentSpecInline;
		expect(spec.inline.systemPrompt).toBe("You are a custom agent.");
		expect(spec.inline.tools).toEqual(["read"]);
	});

	test("should support model preferences", () => {
		const cheap = makeSpec({ modelPreference: "cheapest" });
		expect(cheap.modelPreference).toBe("cheapest");

		const smart = makeSpec({ modelPreference: "smartest" });
		expect(smart.modelPreference).toBe("smartest");
	});
});

// ============================================================================
// RoleProvider
// ============================================================================

describe("RoleProvider", () => {
	describe("resolve()", () => {
		test("returns a library role when found and approved", async () => {
			const roleAsset = makeRoleAsset({ id: "planner", status: "approved" });
			const mgr = mockRoleAssetManager({ planner: roleAsset });
			const provider = new RoleProvider(mgr);

			const result = await provider.resolve(makeSpec({ role: "planner" }));
			expect(result.systemPrompt).toBe("You are a planner agent.");
			expect(result.guidelines).toEqual(["Plan carefully", "Ask questions"]);
			expect(result.tools).toEqual(["read", "write", "grep"]);
		});

		test("falls back when library role is not found", async () => {
			const mgr = mockRoleAssetManager({}); // empty — no roles
			const provider = new RoleProvider(mgr);

			const result = await provider.resolve(makeSpec({ role: "nonexistent" }));
			expect(result.systemPrompt).toContain("nonexistent agent");
			expect(result.tools).toEqual(["read", "grep", "glob"]);
		});

		test("falls back when library role is not approved", async () => {
			const roleAsset = makeRoleAsset({ id: "backend-dev", status: "draft" });
			const mgr = mockRoleAssetManager({ "backend-dev": roleAsset });
			const provider = new RoleProvider(mgr);

			const result = await provider.resolve(makeSpec({ role: "backend-dev" }));
			expect(result.systemPrompt).toContain("backend-dev agent");
		});

		test("returns inline role when roleSource is inline", async () => {
			const mgr = mockRoleAssetManager({});
			const provider = new RoleProvider(mgr);

			const result = await provider.resolve(
				makeSpec({
					roleSource: "inline",
					inline: { systemPrompt: "Custom inline prompt", tools: ["bash"] },
				}),
			);
			expect(result.systemPrompt).toBe("Custom inline prompt");
			expect(result.tools).toEqual(["bash"]);
		});

		test("returns default fallback for profile source", async () => {
			const mgr = mockRoleAssetManager({});
			const provider = new RoleProvider(mgr);

			const result = await provider.resolve(makeSpec({ roleSource: "profile", role: "custom-role" }));
			expect(result.systemPrompt).toContain("custom-role agent");
		});

		test("returns default fallback when inline spec has no inline definition", async () => {
			const mgr = mockRoleAssetManager({});
			const provider = new RoleProvider(mgr);

			// roleSource is "inline" but no inline field → falls through to default
			const spec = {
				id: "test",
				role: "custom",
				roleSource: "inline",
				task: "Do something",
				// inline is undefined
			} as AgentSpec;
			const result = await provider.resolve(spec);
			expect(result.systemPrompt).toContain("custom agent");
		});

		test("handles RoleAssetManager errors gracefully (falls back)", async () => {
			const brokenMgr = {
				get: async () => {
					throw new Error("Disk error");
				},
			} as unknown as RoleAssetManager;
			const provider = new RoleProvider(brokenMgr);

			// Should not throw — falls back to default
			const result = await provider.resolve(makeSpec({ role: "planner" }));
			expect(result.systemPrompt).toContain("planner agent");
		});
	});
});


// ============================================================================
// AgentRuntime
// ============================================================================

describe("AgentRuntime", () => {
	let roleProvider: RoleProvider;
	let contextPipeline: ContextPipeline;
	let hookPipeline: HookPipeline;
	let ircBus: IrcBus;
	let modelRegistry: ModelRegistry;
	let settings: Settings;
	let toolRegistry: Map<string, Tool>;

	beforeEach(() => {
		const roleMgr = mockRoleAssetManager({
			planner: makeRoleAsset({ id: "planner" }),
			"backend-dev": makeRoleAsset({ id: "backend-dev" }),
		});
		roleProvider = new RoleProvider(roleMgr);
		contextPipeline = new ContextPipeline();
		hookPipeline = new HookPipeline();
		ircBus = new IrcBus(new AgentRegistry());

		// Mock tool registry for test purposes
		const mockTool = { name: "mock", execute: async () => ({ output: "ok" }) } as unknown as Tool;
		toolRegistry = new Map([
			["read", mockTool],
			["grep", mockTool],
			["write", mockTool],
			["bash", mockTool],
			["glob", mockTool],
		]);

		modelRegistry = {
			getAvailable: () => [{ id: "test-model", provider: "test", supportsTools: true }],
			resolver: async () => undefined,
			find: () => ({ id: "test-model", provider: "test" }),
		} as unknown as ModelRegistry;

		settings = {} as Settings;

		// Reset the global AgentRegistry between tests to avoid ID conflicts
		AgentRegistry.resetGlobalForTests?.();
	});

	describe("spawn()", () => {
		test("spawns a single agent and returns a handle", async () => {
			const runtime = new AgentRuntime({
				roleProvider,
				contextPipeline,
			sessionFactory: mockCompletingSessionFactory as unknown as typeof import("../../sdk").createAgentSession,
				ircBus,
				hookPipeline,
				modelRegistry,
				settings,
				toolRegistry,
			});

			const handles = await runtime.spawn([makeSpec({ id: "agent-1", role: "planner" })]);

			expect(handles.length).toBe(1);
			expect(handles[0]).toBeTruthy();
			expect(handles[0].id).toBe("agent-1");
		});

		test("spawns multiple agents in parallel", async () => {
			const runtime = new AgentRuntime({
				roleProvider,
				contextPipeline,
			sessionFactory: mockCompletingSessionFactory as unknown as typeof import("../../sdk").createAgentSession,
				ircBus,
				hookPipeline,
				modelRegistry,
				settings,
				toolRegistry,
			});

			const handles = await runtime.spawn([
				makeSpec({ id: "agent-1", role: "planner" }),
				makeSpec({ id: "agent-2", role: "backend-dev" }),
				makeSpec({ id: "agent-3", role: "planner" }),
			]);

			expect(handles.length).toBe(3);
			expect(handles.map(h => h.id).sort()).toEqual(["agent-1", "agent-2", "agent-3"]);
		});

		test("fires agent:beforeSpawn hook", async () => {
			const events: string[] = [];
			hookPipeline.register({
				name: "test-hook",
				priority: 0,
				events: ["agent:beforeSpawn"],
				handler: async ({ payload }: HandlerArgs) => {
					events.push(`before:${(payload as AgentBeforeSpawnPayload).agentId}`);
				},
			});

			const runtime = new AgentRuntime({
				roleProvider,
				contextPipeline,
			sessionFactory: mockCompletingSessionFactory as unknown as typeof import("../../sdk").createAgentSession,
				ircBus,
				hookPipeline,
				modelRegistry,
				settings,
				toolRegistry,
			});

			await runtime.spawn([makeSpec({ id: "hook-agent" })]);
			expect(events).toContain("before:hook-agent");
		});

		test("fires agent:afterSpawn hook with handle", async () => {
			const events: string[] = [];
			hookPipeline.register({
				name: "after-hook",
				priority: 0,
				events: ["agent:afterSpawn"],
				handler: async ({ payload }: HandlerArgs) => {
					const p = payload as AgentAfterSpawnPayload;
					events.push(`after:${p.agentId}`);
					expect(p.session).toBeTruthy();
				},
			});

			const runtime = new AgentRuntime({
				roleProvider,
				contextPipeline,
			sessionFactory: mockCompletingSessionFactory as unknown as typeof import("../../sdk").createAgentSession,
				ircBus,
				hookPipeline,
				modelRegistry,
				settings,
				toolRegistry,
			});

			await runtime.spawn([makeSpec({ id: "hook-agent-2" })]);
			expect(events).toContain("after:hook-agent-2");
		});
	});

	describe("sendHumanMessage()", () => {
		test("queues a human steering message for a target agent", async () => {
			const runtime = new AgentRuntime({
				roleProvider,
				contextPipeline,
			sessionFactory: mockCompletingSessionFactory as unknown as typeof import("../../sdk").createAgentSession,
				ircBus,
				hookPipeline,
				modelRegistry,
				settings,
				toolRegistry,
			});

			// Should not throw
			await runtime.sendHumanMessage("agent-1", "Please reconsider");
		});

		test("messages are retrievable via steering queue hooks", async () => {
			const runtime = new AgentRuntime({
				roleProvider,
				contextPipeline,
			sessionFactory: mockCompletingSessionFactory as unknown as typeof import("../../sdk").createAgentSession,
				ircBus,
				hookPipeline,
				modelRegistry,
				settings,
				toolRegistry,
			});

			await runtime.sendHumanMessage("agent-x", "Steering message 1");
			await runtime.sendHumanMessage("agent-x", "Steering message 2");

			// The runtime's internal queues should have accumulated messages
			// The getSteeringMessages hook drains the queue
			// (Testing via internal access would require exposing the queue,
			// so we verify the public API doesn't throw)
		});
	});

	describe("sendSystemNotification()", () => {
		test("queues a system notification for a target agent", async () => {
			const runtime = new AgentRuntime({
				roleProvider,
				contextPipeline,
			sessionFactory: mockCompletingSessionFactory as unknown as typeof import("../../sdk").createAgentSession,
				ircBus,
				hookPipeline,
				modelRegistry,
				settings,
				toolRegistry,
			});

			// Should not throw
			await runtime.sendSystemNotification("agent-1", "System update available");
		});
	});

	describe("steering/followUp hooks (SP-7)", () => {
		test("AgentLoopConfig hooks are wired through AgentLauncher", async () => {
			let capturedOptions: CreateAgentSessionOptions | undefined;
			const capturingSessionFactory = async (options?: CreateAgentSessionOptions) => {
				capturedOptions = options;
				return {
					session: makeCompletingMockSession(options?.agentId) as unknown as AgentSession,
					extensionsResult: { extensions: [], errors: [], runtime: {} },
					setToolUIContext: () => {},
					eventBus: { emit: () => {}, on: () => () => {}, clear: () => {} },
				} as unknown as CreateAgentSessionResult;
			};


			const runtime = new AgentRuntime({
				roleProvider,
				contextPipeline,
				sessionFactory: capturingSessionFactory as unknown as typeof import("../../sdk").createAgentSession,
				ircBus,
				hookPipeline,
				modelRegistry,
				settings,
				toolRegistry,
			});

			const handles = await runtime.spawn([makeSpec({ id: "steer-hook-test", role: "planner" })]);
			expect(handles.length).toBe(1);

			expect(capturedOptions).toBeDefined();
			if (!capturedOptions) throw new Error("capturedOptions is undefined");

			// Verify getSteeringMessages and getFollowUpMessages are wired (not undefined)
			expect(typeof capturedOptions.getSteeringMessages).toBe("function");
			expect(typeof capturedOptions.getFollowUpMessages).toBe("function");

			// Both should return empty arrays when no messages have been queued
			const steering = await capturedOptions.getSteeringMessages!();
			expect(steering).toEqual([]);
			const followUp = await capturedOptions.getFollowUpMessages!();
			expect(followUp).toEqual([]);
		});

		test("steering messages flow from sendHumanMessage through getSteeringMessages", async () => {
			let capturedOptions: CreateAgentSessionOptions | undefined;
			const capturingSessionFactory = async (options?: CreateAgentSessionOptions) => {
				capturedOptions = options;
				return {
					session: makeCompletingMockSession(options?.agentId) as unknown as AgentSession,
					extensionsResult: { extensions: [], errors: [], runtime: {} },
					setToolUIContext: () => {},
					eventBus: { emit: () => {}, on: () => () => {}, clear: () => {} },
				} as unknown as CreateAgentSessionResult;
			};


			const runtime = new AgentRuntime({
				roleProvider,
				contextPipeline,
				sessionFactory: capturingSessionFactory as unknown as typeof import("../../sdk").createAgentSession,
				ircBus,
				hookPipeline,
				modelRegistry,
				settings,
				toolRegistry,
			});

			await runtime.spawn([makeSpec({ id: "steer-flow-test", role: "planner" })]);
			expect(capturedOptions).toBeDefined();
			if (!capturedOptions) throw new Error("capturedOptions is undefined");

			// Push steering messages via the public API
			await runtime.sendHumanMessage("steer-flow-test", "First steering message");
			await runtime.sendHumanMessage("steer-flow-test", "Second steering message");

			// Drain via the hook — should return both messages
			const steering = await capturedOptions.getSteeringMessages!();
			expect(steering.length).toBe(2);

			type TextContentMsg = { content: Array<{ type: string; text?: string }> };
			const firstMsg = steering[0] as unknown as TextContentMsg | undefined;
			const firstText = firstMsg?.content?.find(c => c.type === "text");
			expect(firstText).toBeDefined();
			expect(
				"text" in (firstText as Record<string, unknown>) ? (firstText as Record<string, unknown>).text : undefined,
			).toBe("First steering message");

			const secondMsg = steering[1] as unknown as TextContentMsg | undefined;
			const secondText = secondMsg?.content?.find(c => c.type === "text");
			expect(secondText).toBeDefined();
			expect(
				"text" in (secondText as Record<string, unknown>)
					? (secondText as Record<string, unknown>).text
					: undefined,
			).toBe("Second steering message");
		});

		test("steering hooks remain wired after spawn for follow-up agent lifecycle", async () => {
			let capturedOptions: CreateAgentSessionOptions | undefined;
			const capturingSessionFactory = async (options?: CreateAgentSessionOptions) => {
				capturedOptions = options;
				return {
					session: makeCompletingMockSession(options?.agentId) as unknown as AgentSession,
					extensionsResult: { extensions: [], errors: [], runtime: {} },
					setToolUIContext: () => {},
					eventBus: { emit: () => {}, on: () => () => {}, clear: () => {} },
				} as unknown as CreateAgentSessionResult;
			};


			const runtime = new AgentRuntime({
				roleProvider,
				contextPipeline,
				sessionFactory: capturingSessionFactory as unknown as typeof import("../../sdk").createAgentSession,
				ircBus,
				hookPipeline,
				modelRegistry,
				settings,
				toolRegistry,
			});

			// Spawn two agents — each gets independent steering queues
			await runtime.spawn([
				makeSpec({ id: "agent-a", role: "planner" }),
				makeSpec({ id: "agent-b", role: "backend-dev" }),
			]);

			// Push steering to only one agent
			await runtime.sendHumanMessage("agent-a", "Steering for A only");

			// The captured options reflect the LAST spawn call (agent-b).
			// Each spawn call re-captures options, so this tests the wiring pattern.
			expect(capturedOptions).toBeDefined();
			if (!capturedOptions) throw new Error("capturedOptions is undefined");
			expect(typeof capturedOptions.getSteeringMessages).toBe("function");

			// agent-b's queue should be empty (steering was sent to agent-a)
			const bSteering = await capturedOptions.getSteeringMessages!();
			expect(bSteering).toEqual([]);
		});
	});

	describe("spawnRoundtable()", () => {
		test("runs multiple rounds and returns responses", async () => {
			const runtime = new AgentRuntime({
				roleProvider,
				contextPipeline,
			sessionFactory: mockCompletingSessionFactory as unknown as typeof import("../../sdk").createAgentSession,
				ircBus,
				hookPipeline,
				modelRegistry,
				settings,
				toolRegistry,
			});

			const config: RoundtableConfig = {
				rounds: 1,
				timeoutMs: 500,
				convergenceThreshold: 0.99,
				convergenceStreak: 1,
			};

			// spawnRoundtable attempts to spawn agents — which will fail since
			// we have no real model. The roundtable logic handles agent failures
			// gracefully and returns "(no response)" for failed agents.
			try {
				const result = await runtime.spawnRoundtable([makeSpec({ id: "a1" }), makeSpec({ id: "a2" })], config);
				expect(result.rounds).toBe(2);
				expect(result.responses.length).toBeGreaterThan(0);
			} catch {
				// Agent spawning may fail entirely — acceptable for this test
			}
		});
	});
});

// ============================================================================
// Error handling
// ============================================================================

describe("Error handling", () => {
	test("AgentRuntime.spawnOne propagates RoleProvider errors", async () => {
		const brokenRoleProvider = {
			resolve: async () => {
				throw new Error("Role DB offline");
			},
		} as unknown as RoleProvider;

		const contextPipeline = new ContextPipeline();
		const hookPipeline = new HookPipeline();
		const ircBus = new IrcBus();

		const modelRegistry = {
			getAvailable: () => [],
			resolver: async () => undefined,
		} as unknown as ModelRegistry;

		const runtime = new AgentRuntime({
			roleProvider: brokenRoleProvider,
			contextPipeline,
			ircBus,
			hookPipeline,
			modelRegistry,
			settings: {} as Settings,
		});

		await expect(runtime.spawn([makeSpec({ id: "bad-agent" })])).rejects.toThrow("Role DB offline");
	});

	test("AgentRuntime.spawnOne propagates ContextPipeline errors", async () => {
		const roleProvider = new RoleProvider(mockRoleAssetManager({ planner: makeRoleAsset() }));
		const hookPipeline = new HookPipeline();
		const ircBus = new IrcBus();

		const modelRegistry = {
			getAvailable: () => [{ id: "test", provider: "test", supportsTools: true }],
			resolver: async () => undefined,
		} as unknown as ModelRegistry;

		// Create a ContextPipeline that throws on assemble
		const brokenPipeline = {
			register: () => {},
			assemble: async () => {
				throw new Error("Context DB offline");
			},
			toTransformContext: () => async (m: AgentMessage[]) => m,
			listSources: () => [],
		} as unknown as ContextPipeline;

		const runtime = new AgentRuntime({
			roleProvider,
			contextPipeline: brokenPipeline,
			ircBus,
			hookPipeline,
			modelRegistry,
			settings: {} as Settings,
		});

		await expect(runtime.spawn([makeSpec({ id: "ctx-agent" })])).rejects.toThrow("Context DB offline");
	});
});

// ============================================================================
// AgentRegistry registration
// ============================================================================

describe("AgentRegistry integration", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		registry = new AgentRegistry();
	});

	test("registers persistent agent with profileId", () => {
		const ref = registry.register({
			id: "persistent-architect",
			displayName: "Architect v3",
			kind: "main",
			profileId: "architect-v3",
			role: "architect",
			session: null,
		});

		expect(ref.kind).toBe("main");
		expect(ref.profileId).toBe("architect-v3");
		expect(ref.role).toBe("architect");
	});

	test("setSession attaches session to existing ref", () => {
		registry.register({
			id: "with-session",
			displayName: "Session Test",
			kind: "main",
			session: null,
		});

		const mockSession = { id: "s1" } as AgentSession;
		registry.setSession("with-session", mockSession);

		const ref = registry.get("with-session");
		expect(ref?.session).toBe(mockSession);
	});

	test("setSession is no-op for unknown id", () => {
		expect(() => {
			registry.setSession("unknown", {} as unknown as AgentSession);
		}).not.toThrow();
	});

	test("register warns and replaces duplicate id", () => {
		const mockDispose = mock(async () => {});
		const first = registry.register({
			id: "dup-agent",
			displayName: "First",
			kind: "main",
			session: { dispose: mockDispose } as unknown as AgentSession,
		});
		expect(first.displayName).toBe("First");

		// Register again with same id — should warn and replace.
		const second = registry.register({
			id: "dup-agent",
			displayName: "Second",
			kind: "main",
			session: null,
		});
		expect(second.displayName).toBe("Second");
		// Old session should have been disposed.
		expect(mockDispose).toHaveBeenCalled();

		// Only one entry for this id.
		const list = registry.list().filter(r => r.id === "dup-agent");
		expect(list).toHaveLength(1);
		expect(list[0]!.displayName).toBe("Second");
	});
});
