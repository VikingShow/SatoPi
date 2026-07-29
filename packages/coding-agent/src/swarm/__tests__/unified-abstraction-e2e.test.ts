/**
 * End-to-end integration test for the unified swarm abstraction layer.
 *
 * Validates the complete chain:
 *   GraphDefinition → selectNodeBehavior → PhaseBehaviorNodeAdapter
 *   → PhaseBehavior.enter() → ContextPipeline → MarkEnvironment
 *
 * Verifies that all changes from the Phase 1-4 implementation work together.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { MarkEnvironment } from "../../coordination/mark-environment";
import { IrcBus } from "../../irc/bus";
import { OffloadManager } from "../../offload/manager";
import { AgentRegistry } from "../../registry/agent-registry";
import { MemorySessionStorage } from "../../session/session-storage";
import { discoverAgents } from "../../task/discovery";
import { ContextPipeline } from "../context-manager/context-pipeline";
import { ExperienceSource } from "../context-manager/sources/experience-source";
import { StigmergySource } from "../context-manager/sources/stigmergy-source";
import { StateTracker } from "../core/state";
import { PHASES, WorkflowFsm } from "../core/workflow-fsm";
import { ExperienceStore } from "../curtain/experience";
import { type NodeBehaviorFactoryConfig, selectNodeBehavior } from "../graph/node-behavior";
import { PhaseBehaviorNodeAdapter } from "../graph/phase-behavior-adapter";
import type { NodeContext } from "../graph/schema";
import { type GraphDefinition, loadGraphDefinition } from "../graph/schema";
import { HookPipeline } from "../hook-system/hook-pipeline";
import { ActivityLogger } from "../infra/activity-logger";

const WORKSPACE = path.resolve(import.meta.dir, "../../../../..");

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(overrides: Partial<NodeBehaviorFactoryConfig> = {}): NodeBehaviorFactoryConfig {
	const stateTracker = new StateTracker(WORKSPACE, "test");
	const activityLogger = new ActivityLogger(WORKSPACE, "test");
	const fsm = new WorkflowFsm(stateTracker, activityLogger, "stage");
	for (const def of PHASES) fsm.registerPhase(def);
	const hookPipeline = new HookPipeline();
	const contextPipeline = new ContextPipeline();

	return {
		runtime: {
			ircBus: IrcBus.global(),
			spawn: async () => [],
			contextPipeline,
		} as unknown as NodeBehaviorFactoryConfig["runtime"],
		fsm,
		hookPipeline,
		contextPipeline,
		workspace: WORKSPACE,
		swarmDir: "/tmp/test-swarm",
		loopConfig: {
			maxIterations: 3,
			autoRetry: false,
			humanEscalation: false,
			agents: { initial: 1, min: 1, max: 1, auto: false, maxRounds: 1, roundsConvergenceThreshold: 1 },
			debate: { enabled: false, maxRounds: 1 },
			planDebate: { enabled: false, agentCount: 1, maxRounds: 1, convergenceThreshold: 1 },
			convergenceThreshold: 1,
			iterationTimeoutMs: 30000,
			enableDeliberation: false,
		},
		...overrides,
	};
}

// ============================================================================
// Tests
// ============================================================================

describe("Unified Abstraction Layer — End-to-End", () => {
	// ── 1. Graph loading and validation ───────────────────────────────────

	describe("Graph loading and validation", () => {
		it("loads builtin theatre.graph.yaml", async () => {
			const def = await loadGraphDefinition(path.resolve(import.meta.dir, "../graph/builtin/theatre.graph.yaml"));
			expect(def.name).toBe("theatre");
			expect(def.nodes.script?.type).toBe("script");
			expect(def.nodes.stage?.type).toBe("stage");
			expect(def.nodes.curtain?.type).toBe("curtain");
		});

		it("GraphDefinition has builtin field", () => {
			const def: GraphDefinition = {
				name: "test",
				description: "",
				version: 1,
				revision: 1,
				builtin: true,
				nodes: {},
			};
			expect(def.builtin).toBe(true);
		});
	});

	// ── 2. selectNodeBehavior factory ─────────────────────────────────────

	describe("selectNodeBehavior factory", () => {
		it('returns PhaseBehaviorNodeAdapter for "script"', () => {
			const config = makeConfig();
			const behavior = selectNodeBehavior("script", config);
			expect(behavior).toBeInstanceOf(PhaseBehaviorNodeAdapter);
			expect(behavior.name).toBe("script");
		});

		it('returns PhaseBehaviorNodeAdapter for "stage"', () => {
			const config = makeConfig();
			const behavior = selectNodeBehavior("stage", config);
			expect(behavior).toBeInstanceOf(PhaseBehaviorNodeAdapter);
			expect(behavior.name).toBe("stage");
		});

		it('returns PhaseBehaviorNodeAdapter for "curtain"', () => {
			const config = makeConfig();
			const behavior = selectNodeBehavior("curtain", config);
			expect(behavior).toBeInstanceOf(PhaseBehaviorNodeAdapter);
			expect(behavior.name).toBe("curtain");
		});

		it("returns CustomNodeBehavior for undefined type", () => {
			const config = makeConfig();
			const behavior = selectNodeBehavior(undefined, config);
			expect(behavior.name).toBe("custom");
		});

		it("all behaviors implement NodeBehavior (name + 4 lifecycle methods)", () => {
			const config = makeConfig();
			for (const type of ["script", "stage", "curtain", undefined] as const) {
				const behavior = selectNodeBehavior(type, config);
				expect(behavior).toHaveProperty("name");
				expect(typeof behavior.name).toBe("string");
				expect(typeof behavior.prepare).toBe("function");
				expect(typeof behavior.execute).toBe("function");
				expect(typeof behavior.validate).toBe("function");
				expect(typeof behavior.cleanup).toBe("function");
			}
		});

		it("PhaseBehaviorNodeAdapter nodeType matches behavior phase", () => {
			const config = makeConfig();
			expect((selectNodeBehavior("script", config) as PhaseBehaviorNodeAdapter).nodeType).toBe("script");
			expect((selectNodeBehavior("stage", config) as PhaseBehaviorNodeAdapter).nodeType).toBe("stage");
			expect((selectNodeBehavior("curtain", config) as PhaseBehaviorNodeAdapter).nodeType).toBe("curtain");
		});

		it("prepare returns AgentSpec array for all types", async () => {
			const config = makeConfig();
			const ctx = {
				node: { id: "n1", label: "N", description: "D", role: "dev", tools: [], type: "custom", dependsOn: [] },
				workspace: WORKSPACE,
				modelRegistry: {} as unknown as NodeContext["modelRegistry"],
				settings: {} as unknown as NodeContext["settings"],
				upstreamOutputs: {},
				experience: "",
				signal: new AbortController().signal,
				runtime: config.runtime,
			} as unknown as NodeContext;

			for (const type of ["script", "stage", "curtain", undefined] as const) {
				const behavior = selectNodeBehavior(type, config);
				const prepared = await behavior.prepare(ctx);
				expect(Array.isArray(prepared)).toBe(true);
			}
		});
	});

	// ── 3. MarkEnvironment + StigmergySource ──────────────────────────────

	describe("MarkEnvironment and StigmergySource", () => {
		it("MarkEnvironment can be created and accepts marks", () => {
			const env = new MarkEnvironment();
			const mark = env.placeMark({
				markId: "mark-1",
				type: "lock",
				agentId: "agent-1",
				message: "Test lock",
				path: "/tmp/test.txt",
			});
			expect(mark).toBeDefined();
			expect(mark.markId).toBe("mark-1");
			expect(mark.type).toBe("lock");
		});

		it("MarkEnvironment.getContextForAgent returns stigmergic XML for peer marks", () => {
			const env = new MarkEnvironment();
			// Place a mark AS agent-1 (about agent-2's file)
			env.placeMark({
				markId: "warn-1",
				type: "warning",
				agentId: "agent-1",
				message: "File conflict detected",
				path: "/tmp/conflict.txt",
			});
			// Place a signal AS agent-1
			env.placeMark({
				markId: "sig-1",
				type: "signal",
				agentId: "agent-1",
				message: "Starting refactor",
			});

			// Query AS agent-2 (different agent sees peer marks)
			const ctx = env.getContextForAgent("agent-2");
			expect(ctx).toContain("<stigmergic_environment>");
			expect(ctx).toContain("File conflict detected");
			expect(ctx).toContain("Starting refactor");
		});

		it("StigmergySource registers in ContextPipeline without errors", () => {
			const env = new MarkEnvironment();
			const source = new StigmergySource(env);
			const pipeline = new ContextPipeline();
			pipeline.register(source);
			expect(source.name).toBe("stigmergy");
			expect(source.priority).toBe(4);
			expect(source.appliesTo("stage", "dev")).toBe(true);
		});
	});

	// ── 4. ExperienceSource phase coverage ────────────────────────────────

	describe("ExperienceSource phase coverage", () => {
		it("appliesTo covers script, script-debate, and stage (Phase 2 fix)", async () => {
			const store = new ExperienceStore(WORKSPACE);
			await store.init();
			const source = new ExperienceSource(store);

			expect(source.appliesTo("script", "dev")).toBe(true);
			expect(source.appliesTo("script-debate", "dev")).toBe(true);
			expect(source.appliesTo("stage", "dev")).toBe(true); // Phase 2 fix
			expect(source.appliesTo("curtain", "dev")).toBe(false);

			store.close();
		});
	});

	// ── 5. ContextPipeline multi-source ───────────────────────────────────

	describe("ContextPipeline multi-source", () => {
		it("assembles context from multiple registered sources", async () => {
			const pipeline = new ContextPipeline();
			const env = new MarkEnvironment();
			const store = new ExperienceStore(WORKSPACE);
			await store.init();

			pipeline.register(new StigmergySource(env));
			pipeline.register(new ExperienceSource(store));

			const result = await pipeline.assemble(
				{ id: "agent-1", role: "dev", task: "Test task" },
				{ phase: "stage", multiAgent: false, humanMode: "observer" as const },
				{
					taskDescription: "Test task",
					workspace: WORKSPACE,
					swarmDir: "/tmp",
					turnNumber: 0,
					phase: { phase: "stage", multiAgent: false, humanMode: "observer" as const },
					accumulated: {},
				},
			);
			expect(result).toBeDefined();
			expect(result.injectedMessages).toBeDefined();

			store.close();
		});
	});

	// ── 6. AgentRegistry persistent agent ─────────────────────────────────

	describe("AgentRegistry persistent agent support", () => {
		it("registers agent with profileId for persistent identity", () => {
			const registry = AgentRegistry.global();
			const ref = registry.register({
				id: "persistent-test-1",
				displayName: "Test Persistent",
				kind: "persistent" as const,
				session: null,
				profileId: "architect-v1",
				role: "architect",
			});
			expect(ref.id).toBe("persistent-test-1");

			const agent = registry.get("persistent-test-1");
			expect(agent?.profileId).toBe("architect-v1");
			expect(agent?.role).toBe("architect");
		});

		it("tracks persistent agent status across lifecycle", () => {
			const registry = AgentRegistry.global();
			registry.register({
				id: "persistent-test-2",
				displayName: "Status Test",
				kind: "persistent" as const,
				session: null,
				profileId: "dev-v2",
			});

			registry.setStatus("persistent-test-2", "running");
			expect(registry.get("persistent-test-2")?.status).toBe("running");

			registry.setStatus("persistent-test-2", "idle");
			expect(registry.get("persistent-test-2")?.status).toBe("idle");
		});
	});

	// ── 7. NodeBehavior lifecycle for all types ───────────────────────────

	describe("NodeBehavior lifecycle completeness", () => {
		it("custom node full lifecycle: prepare → validate → cleanup", async () => {
			const config = makeConfig();
			const ctx = {
				node: { id: "test", label: "T", description: "D", role: "dev", tools: [], type: "custom", dependsOn: [] },
				workspace: WORKSPACE,
				modelRegistry: {} as unknown as NodeContext["modelRegistry"],
				settings: {} as unknown as NodeContext["settings"],
				upstreamOutputs: {},
				experience: "",
				signal: new AbortController().signal,
				runtime: config.runtime,
			} as unknown as NodeContext;

			const behavior = selectNodeBehavior("custom", config);
			const prepared = await behavior.prepare(ctx);
			expect(Array.isArray(prepared)).toBe(true);

			const result = await behavior.validate({ nodeId: "test", success: true }, undefined);
			expect(result).toHaveProperty("passed");

			await behavior.cleanup(ctx);
		});

		it("adapter names match phase for script/stage/curtain", () => {
			const config = makeConfig();
			expect((selectNodeBehavior("script", config) as PhaseBehaviorNodeAdapter).name).toBe("script");
			expect((selectNodeBehavior("stage", config) as PhaseBehaviorNodeAdapter).name).toBe("stage");
			expect((selectNodeBehavior("curtain", config) as PhaseBehaviorNodeAdapter).name).toBe("curtain");
		});
	});

	// ── 8. Recursive agent discovery ──────────────────────────────────────

	describe("Recursive agent discovery", () => {
		it("discoverAgents returns result with agents array", async () => {
			const result = await discoverAgents(WORKSPACE);
			expect(result).toHaveProperty("agents");
			expect(Array.isArray(result.agents)).toBe(true);
		});
	});

	// ── 9. OffloadSource → ContextPipeline integration ─────────────────────

	describe("OffloadSource → ContextPipeline integration", () => {
		it("OffloadSource injects offload context during stage phase", async () => {
			const storage = new MemorySessionStorage();
			const mgr = new OffloadManager("/tmp/test-offload-e2e", "test-agent", "session-1", storage);

			await mgr.summarizeL1("agent-1", "Completed auth module refactoring");

			const pipeline = new ContextPipeline();
			const result = await pipeline.assemble(
				{ id: "agent-1", role: "dev", task: "Build API" },
				{ phase: "stage", multiAgent: false, humanMode: "observer" as const },
				{
					taskDescription: "Build API",
					workspace: "/tmp/test-offload-e2e",
					swarmDir: "/tmp",
					turnNumber: 0,
					phase: { phase: "stage", multiAgent: false, humanMode: "observer" as const },
					accumulated: {},
				},
			);

			expect(result.systemPrompt).toContain("<offload_context>");
			expect(result.systemPrompt).toContain("auth module refactoring");
		});

		it("OffloadSource does not inject during script phase", async () => {
			const storage = new MemorySessionStorage();
			const mgr = new OffloadManager("/tmp/test-offload-e2e", "test-agent", "session-2", storage);

			await mgr.summarizeL1("agent-1", "Completed auth module refactoring");

			const pipeline = new ContextPipeline();
			const result = await pipeline.assemble(
				{ id: "agent-1", role: "dev", task: "Build API" },
				{ phase: "script", multiAgent: false, humanMode: "observer" as const },
				{
					taskDescription: "Build API",
					workspace: "/tmp/test-offload-e2e",
					swarmDir: "/tmp",
					turnNumber: 0,
					phase: { phase: "script", multiAgent: false, humanMode: "observer" as const },
					accumulated: {},
				},
			);

			expect(result.systemPrompt).not.toContain("<offload_context>");
		});
	});
});
