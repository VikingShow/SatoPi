// biome-ignore-all lint/suspicious/noTemplateCurlyInString: condition DSL literals in YAML
// biome-ignore-all lint/suspicious/noUselessEscapeInString: `\$` escapes `${` in YAML
import { describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentSession } from "../../session/agent/agent-session";
import type { StateTracker } from "../../swarm/core/state";
import type { SwarmInfra } from "../../swarm/core/swarm-infra";
import type { NodeExecutionContext, NodeExecutor } from "../graph-engine";
import { GraphEngine } from "../graph-engine";
import { GraphRunner } from "../graph-runner";
import { parseGraphYaml, validateGraphDefinition } from "../schema";
import type { GraphDefinition, NodeResult } from "../types";

// ============================================================================
// Helpers
// ============================================================================

function makeCheckpoint() {
	let state:
		| Parameters<NonNullable<ConstructorParameters<typeof GraphEngine>[0]>["checkpointStore"]["write"]>[0]
		| null = null;
	return {
		write: (s: unknown): boolean => {
			state = s as typeof state;
			return true;
		},
		recover: async (): Promise<unknown> => state,
	};
}

// ============================================================================
// Conditional routing — schema parsing & validation
// ============================================================================

describe("conditional routing schema", () => {
	it("parses node.routes from YAML", () => {
		const yaml = `
graph:
  name: cond
  description: conditional graph
  version: 1
  revision: 0
  strategy: dynamic
  nodes:
    build:
      label: Build
      description: build step
      role: builder
      tools: []
      depends_on: []
    deploy:
      label: Deploy
      description: deploy on success
      role: deployer
      tools: []
      depends_on: [build]
    rollback:
      label: Rollback
      description: rollback on failure
      role: ops
      tools: []
      depends_on: [build]
    build:
      label: Build
      description: build step
      role: builder
      tools: []
      depends_on: []
      routes:
        conditions:
          - when: "\${build}.exitCode == 0"
            to: deploy
        default: rollback
`;
		const def = parseGraphYaml(yaml);
		expect(def.nodes.build!.routes).toBeDefined();
		expect(def.nodes.build!.routes!.conditions).toHaveLength(1);
		expect(def.nodes.build!.routes!.default).toBe("rollback");
		const errors = validateGraphDefinition(def);
		expect(errors).toHaveLength(0);
	});

	it("rejects routes targeting unknown nodes", () => {
		const def = parseGraphYaml(`
graph:
  name: cond
  description: conditional graph
  version: 1
  revision: 0
  nodes:
    build:
      label: Build
      description: build
      role: builder
      tools: []
      depends_on: []
      routes:
        conditions:
          - when: "\${build}.exitCode == 0"
            to: nope
`);
		const errors = validateGraphDefinition(def);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.some(e => e.path.includes("routes"))).toBe(true);
	});

	it("rejects invalid condition syntax at parse time", () => {
		expect(() =>
			parseGraphYaml(`
graph:
  name: cond
  description: conditional graph
  version: 1
  revision: 0
  nodes:
    build:
      label: Build
      description: build
      role: builder
      tools: []
      depends_on: []
      routes:
        conditions:
          - when: "build.exitCode =="
            to: build
`),
		).toThrow(/invalid condition/i);
	});

	it("parses edge.condition from YAML", () => {
		const def = parseGraphYaml(`
graph:
  name: cond
  description: conditional graph
  version: 1
  revision: 0
  strategy: dynamic
  nodes:
    a:
      label: A
      description: a
      role: worker
      tools: []
      depends_on: []
    b:
      label: B
      description: b
      role: worker
      tools: []
      depends_on: []
  edges:
    - from: a
      to: b
      condition: "\${a}.success"
`);
		expect(def.edges![0]!.condition).toBe("${a}.success");
		expect(validateGraphDefinition(def)).toHaveLength(0);
	});
});

// ============================================================================
// Conditional routing — dynamic scheduler execution
// ============================================================================

// Real-chain harness: drives GraphRunner.execute (engine → runner →
// CustomNodeBehavior → runtime.spawn → session.wait()) so exitCode must
// actually flow through the production path for `${node}.exitCode == 0`
// routing to hit its branch. A dropped exitCode (undefined) evaluates
// `undefined == 0` as false and would route to the default target instead.

const CONDITIONAL_GRAPH_YAML = `
graph:
  name: cond-exit
  description: conditional routing on real exit code
  version: 1
  revision: 0
  strategy: dynamic
  nodes:
    build:
      label: Build
      description: build task
      role: builder
      tools: []
      depends_on: []
      routes:
        conditions:
          - when: "\${build}.exitCode == 0"
            to: deploy
        default: rollback
    deploy:
      label: Deploy
      description: deploy task
      role: deployer
      tools: []
      depends_on: [build]
    rollback:
      label: Rollback
      description: rollback task
      role: ops
      tools: []
      depends_on: [build]
`;

interface ExitCodeHarness {
	runner: GraphRunner;
	agentUpdates: Array<{ id: string; update: { status?: string; error?: string } }>;
	phases: string[];
	runDir: string;
	reporter: EventSession;
	reflector: EventSession;
}

interface EventSession {
	session: AgentSession;
	emit: (event: unknown) => void;
	listenerCount: () => number;
}

/** Agent session whose wait() resolves with a fixed exit code. */
function makeWorkSession(id: string, role: string, exitCode: number): AgentSession {
	return {
		id,
		role,
		status: "completed",
		wait: mock(async () => ({
			index: 0,
			id,
			agent: id,
			agentSource: "bundled",
			task: "",
			exitCode,
			output: exitCode === 0 ? "ok" : "failed",
			stderr: "",
			truncated: false,
			durationMs: 0,
			tokens: 0,
			requests: 0,
		})),
		abort: mock(),
	} as unknown as AgentSession;
}

/** Agent session whose subscribe callback the test drives manually (curtain). */
function makeEventSession(id: string, role: string): EventSession {
	const listeners: Array<(event: unknown) => void> = [];
	const session = {
		id,
		role,
		status: "idle",
		subscribe: (cb: (event: unknown) => void): (() => void) => {
			listeners.push(cb);
			return () => {
				const index = listeners.indexOf(cb);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		abort: mock(),
	} as unknown as AgentSession;
	return {
		session,
		emit: event => {
			for (const cb of [...listeners]) cb(event);
		},
		listenerCount: () => listeners.length,
	};
}

function assistantMessage(stopReason: string): Record<string, unknown> {
	return {
		role: "assistant",
		content: [],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {},
		stopReason,
		timestamp: 0,
	};
}

function agentEndEvent(messages: unknown[]): Record<string, unknown> {
	return { type: "agent_end", messages };
}

/**
 * Build a GraphRunner over a real graph YAML with a mocked runtime whose
 * sessions return a fixed exit code from wait(). Custom nodes (build/deploy/
 * rollback) get work sessions; the curtain spawn gets the two event sessions.
 */
async function createExitCodeHarness(buildExitCode: number): Promise<ExitCodeHarness> {
	const runDir = await mkdtemp(path.join(tmpdir(), "cond-exit-"));
	const yamlPath = path.join(runDir, "cond.graph.yaml");
	await writeFile(yamlPath, CONDITIONAL_GRAPH_YAML);

	const agentUpdates: ExitCodeHarness["agentUpdates"] = [];
	const phases: string[] = [];
	const reporter = makeEventSession("reporter", "reporter");
	const reflector = makeEventSession("reflector", "reflector");

	const stateTracker = {
		state: { phase: "idle", agents: {} },
		updatePipeline: mock().mockResolvedValue(undefined),
		updateAgent: mock((id: string, update: { status?: string; error?: string }) => {
			agentUpdates.push({ id, update });
		}),
		registerAgent: mock(),
		getBestAgent: mock(),
	} as unknown as StateTracker;

	const infra = {
		sessionManager: { appendCustomEntry: mock(), storage: {} },
		stateTracker,
		activityLogger: { logPhase: mock(), logCrash: mock(), logNomination: mock() },
		experienceStore: { close: mock() },
		hookPipeline: { trigger: mock() },
		runtime: {
			spawn: mock(async (specs: Array<{ id: string; role: string }>) => {
				// CurtainBehavior spawns exactly two (reporter + reflector).
				if (specs.length >= 2) return [reporter.session, reflector.session];
				const spec = specs[0]!;
				const exitCode = spec.id === "node-build" ? buildExitCode : 0;
				return [makeWorkSession(spec.id, spec.role, exitCode)];
			}),
			contextPipeline: {},
			ircBus: { receiveFromHuman: mock() },
		},
		roleAssetManager: {},
		markEnvironment: {},
		offloadManager: {},
		ircBus: {},
	} as unknown as SwarmInfra;

	const runner = new GraphRunner({
		workspace: runDir,
		graphPath: yamlPath,
		modelRegistry: {} as never,
		settings: {} as never,
		infra,
		autoApplaud: true,
		onPhaseChange: phase => phases.push(phase),
		readSessionEntries: mock().mockResolvedValue([]),
	});
	await runner.init();

	return { runner, agentUpdates, phases, runDir, reporter, reflector };
}

// These tests drive the REAL GraphRunner lifecycle (production code polls its
// phase-completion loop with Bun.sleep(750) and the curtain lifecycle with
// Bun.sleep(750)), so fake timers cannot control the code under test; we poll
// on state predicates instead of fixed sleeps.
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
		await Bun.sleep(50);
	}
}

/** Drive confirmScript() to completion: run the graph, then finish the curtain
 * phase by completing its reporter/reflector agents. */
async function runGraphToCompletion(h: ExitCodeHarness): Promise<void> {
	const runPromise = h.runner.confirmScript();
	await waitFor(
		() => h.phases.includes("curtain") && h.reporter.listenerCount() >= 1 && h.reflector.listenerCount() >= 1,
	);
	h.reporter.emit(agentEndEvent([assistantMessage("stop")]));
	h.reflector.emit(agentEndEvent([assistantMessage("stop")]));
	await waitFor(() => h.phases.includes("idle"));
	await runPromise;
	await h.runner.dispose();
	await rm(h.runDir, { recursive: true, force: true });
}

describe("conditional routing execution", () => {
	it("routes to the success target when exitCode is 0 through the real execution chain", async () => {
		const h = await createExitCodeHarness(0);
		await runGraphToCompletion(h);

		// build's session.wait() returned exitCode 0 → CustomNodeBehavior put it
		// on the NodeResult → GraphRunner propagated it → the condition
		// "${build}.exitCode == 0" matched → deploy ran, rollback didn't. A
		// dropped exitCode would evaluate `undefined == 0` as false and route to
		// rollback, failing this assertion.
		const updates = h.agentUpdates;
		expect(updates.filter(u => u.id === "build").some(u => u.update.status === "completed")).toBe(true);
		expect(updates.filter(u => u.id === "deploy").some(u => u.update.status === "completed")).toBe(true);
		expect(updates.filter(u => u.id === "rollback").some(u => u.update.status === "completed")).toBe(false);
	});

	it("routes to the default target when exitCode is 1 through the real execution chain", async () => {
		const h = await createExitCodeHarness(1);
		await runGraphToCompletion(h);

		const updates = h.agentUpdates;
		expect(updates.filter(u => u.id === "build").some(u => u.update.status === "completed")).toBe(true);
		expect(updates.filter(u => u.id === "deploy").some(u => u.update.status === "completed")).toBe(false);
		expect(updates.filter(u => u.id === "rollback").some(u => u.update.status === "completed")).toBe(true);
	});

	it("keeps waves mode working for graphs without routing", async () => {
		const def = parseGraphYaml(`
graph:
  name: plain
  description: plain graph
  version: 1
  revision: 0
  nodes:
    a:
      label: A
      description: a
      role: worker
      tools: []
      depends_on: []
    b:
      label: B
      description: b
      role: worker
      tools: []
      depends_on: [a]
`);

		const run = new Set<string>();
		const executor: NodeExecutor = {
			async execute(nodeId: string, _ctx: NodeExecutionContext): Promise<NodeResult> {
				run.add(nodeId);
				return { nodeId, success: true, output: "ran" };
			},
		};

		const engine = new GraphEngine({
			graph: def,
			waves: buildWaves(def),
			checkpointStore: makeCheckpoint() as never,
			graphName: "plain",
		});

		const result = await engine.run(executor);
		expect(run.has("a")).toBe(true);
		expect(run.has("b")).toBe(true);
		expect(result.executionErrors).toHaveLength(0);
	});

	it("routes based on a node's metadata", async () => {
		// A node returns metadata; routes read ${node}.metadata.loopIterations.
		const def = parseGraphYaml(`
graph:
  name: meta
  description: metadata routing
  version: 1
  revision: 0
  strategy: dynamic
  nodes:
    process:
      label: Process
      description: process
      role: worker
      tools: []
      depends_on: []
      routes:
        conditions:
          - when: "\${process}.metadata.loopIterations > 2"
            to: many
        default: few
    many:
      label: Many
      description: many path
      role: worker
      tools: []
      depends_on: [process]
    few:
      label: Few
      description: few path
      role: worker
      tools: []
      depends_on: [process]
`);

		const run = new Set<string>();
		const executor: NodeExecutor = {
			async execute(nodeId: string, _ctx: NodeExecutionContext): Promise<NodeResult> {
				run.add(nodeId);
				if (nodeId === "process") {
					return { nodeId, success: true, output: "done", metadata: { loopIterations: 5 } };
				}
				return { nodeId, success: true, output: "ran" };
			},
		};

		const engine = new GraphEngine({
			graph: def,
			waves: buildWaves(def),
			checkpointStore: makeCheckpoint() as never,
			graphName: "meta",
		});

		const result = await engine.run(executor);
		expect(run.has("process")).toBe(true);
		expect(run.has("many")).toBe(true);
		expect(run.has("few")).toBe(false);
		expect(result.executionErrors).toHaveLength(0);
	});
});

// ============================================================================
// Waves helper
// ============================================================================

function buildWaves(def: GraphDefinition): string[][] {
	// Simple topological waves via iterative resolution.
	const completed = new Set<string>();
	const waves: string[][] = [];
	const remaining = new Set(Object.keys(def.nodes));
	while (remaining.size > 0) {
		const wave: string[] = [];
		for (const nodeId of remaining) {
			const node = def.nodes[nodeId]!;
			if (node.depends_on.every(d => completed.has(d))) wave.push(nodeId);
		}
		if (wave.length === 0) throw new Error("cycle");
		wave.sort();
		for (const id of wave) {
			remaining.delete(id);
			completed.add(id);
		}
		waves.push(wave);
	}
	return waves;
}
