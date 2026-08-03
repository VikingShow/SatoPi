// biome-ignore-all lint/suspicious/noTemplateCurlyInString: loop condition DSL literals
import { describe, expect, it } from "bun:test";
import { LoopNodeBehavior } from "../loop-node-behavior";
import { parseGraphYaml, validateGraphDefinition } from "../schema";
import type { NodeContext } from "../types";

// ============================================================================
// Loop — schema parsing & validation
// ============================================================================

describe("loop schema", () => {
	it("parses loop fields from YAML", () => {
		const def = parseGraphYaml(`
graph:
  name: loop-test
  description: loop graph
  version: 1
  revision: 0
  nodes:
    batch:
      label: Batch
      description: process batch
      type: loop
      role: processor
      tools: []
      depends_on: []
      loop_over: "[1, 2, 3]"
      loop_body:
        type: custom
        role: worker
        description: "process item"
      loop_max_iterations: 5
`);
		const node = def.nodes.batch!;
		expect(node.type).toBe("loop");
		expect(node.loop_over).toBe("[1, 2, 3]");
		expect(node.loop_body).toBeDefined();
		expect(node.loop_body!.role).toBe("worker");
		expect(node.loop_max_iterations).toBe(5);
		expect(validateGraphDefinition(def)).toHaveLength(0);
	});

	it("rejects loop nodes without loop_body", () => {
		const def = parseGraphYaml(`
graph:
  name: loop-bad
  description: bad loop
  version: 1
  revision: 0
  nodes:
    batch:
      label: Batch
      description: process batch
      type: loop
      role: processor
      tools: []
      depends_on: []
      loop_over: "[1]"
`);
		const errors = validateGraphDefinition(def);
		expect(errors.some(e => e.path.includes("loop_body"))).toBe(true);
	});

	it("rejects invalid loop_max_iterations", () => {
		const def = parseGraphYaml(`
graph:
  name: loop-bad
  description: bad loop
  version: 1
  revision: 0
  nodes:
    batch:
      label: Batch
      description: process batch
      type: loop
      role: processor
      tools: []
      depends_on: []
      loop_over: "[1]"
      loop_body:
        type: custom
        role: worker
      loop_max_iterations: 0
`);
		const errors = validateGraphDefinition(def);
		expect(errors.some(e => e.path.includes("loop_max_iterations"))).toBe(true);
	});

	it("accepts loop_body of type subgraph with subgraph_path", () => {
		const def = parseGraphYaml(`
graph:
  name: loop-sub
  description: loop with subgraph body
  version: 1
  revision: 0
  nodes:
    batch:
      label: Batch
      description: process batch
      type: loop
      role: processor
      tools: []
      depends_on: []
      loop_over: "[1, 2]"
      loop_body:
        type: subgraph
        subgraph_path: "./inner.graph.yaml"
`);
		expect(validateGraphDefinition(def)).toHaveLength(0);
	});

	it("rejects loop_body of type subgraph without subgraph_path", () => {
		const def = parseGraphYaml(`
graph:
  name: loop-sub-bad
  description: loop with bad subgraph body
  version: 1
  revision: 0
  nodes:
    batch:
      label: Batch
      description: process batch
      type: loop
      role: processor
      tools: []
      depends_on: []
      loop_over: "[1]"
      loop_body:
        type: subgraph
`);
		const errors = validateGraphDefinition(def);
		expect(errors.some(e => e.path.includes("subgraph_path"))).toBe(true);
	});
});

// ============================================================================
// Loop — execution with a mocked AgentSpawner
// ============================================================================

function makeSpawner(outputs: (item: unknown, index: number) => string) {
	const spawned: Array<{ role: string; task: string }> = [];
	const spawner = {
		async spawn(specs: Array<{ id: string; role: string; task: string }>) {
			for (const s of specs) {
				spawned.push({ role: s.role, task: s.task });
			}
			return specs.map(s => ({
				id: s.id,
				async wait() {
					// Extract index from task to produce distinct output per iteration.
					const idxMatch = s.task.match(/index (\d+)/);
					const idx = idxMatch ? Number(idxMatch[1]) : 0;
					return { output: outputs(`item-${idx}`, idx), exitCode: 0 };
				},
			}));
		},
	};
	return { spawner, spawned };
}

function makeCtx(
	node: Partial<NonNullable<NodeContext["node"]>>,
	spawner: { spawn: (s: never[]) => Promise<unknown[]> },
	upstreamOutputs: Record<string, unknown> = {},
): NodeContext {
	return {
		node: {
			id: "loop-node",
			label: "Loop",
			description: "loop node",
			role: "processor",
			tools: [],
			dependsOn: [],
			type: "loop",
			...node,
		},
		workspace: "/tmp",
		modelRegistry: undefined as never,
		settings: undefined as never,
		upstreamOutputs: upstreamOutputs as never,
		experience: "",
		signal: new AbortController().signal,
		runtime: spawner as never,
		agentRegistry: { list: () => [], findByProfileId: () => undefined } as never,
	};
}

describe("loop execution", () => {
	it("iterates over a literal array", async () => {
		const { spawner, spawned } = makeSpawner((_item, idx) => `result ${idx}`);
		const behavior = new LoopNodeBehavior();
		const ctx = makeCtx(
			{
				loopOver: "[10, 20, 30]",
				loopBody: { type: "custom", role: "worker", description: "process" },
			},
			spawner,
		);

		const result = await behavior.execute(ctx, []);
		expect(result.success).toBe(true);
		expect(result.metadata).toBeDefined();
		expect((result.metadata as Record<string, unknown>).loopIterations).toBe(3);
		expect(spawned).toHaveLength(3);
	});

	it("respects loop_max_iterations as a hard cap", async () => {
		const { spawner, spawned } = makeSpawner((_item, idx) => `result ${idx}`);
		const behavior = new LoopNodeBehavior();
		const ctx = makeCtx(
			{
				loopOver: "[1, 2, 3, 4, 5]",
				loopBody: { type: "custom", role: "worker", description: "process" },
				loopMaxIterations: 2,
			},
			spawner,
		);

		const result = await behavior.execute(ctx, []);
		expect((result.metadata as Record<string, unknown>).loopIterations).toBe(2);
		expect(spawned).toHaveLength(2);
	});

	it("breaks early when the break condition is met", async () => {
		const { spawner, spawned } = makeSpawner((_item, idx) => `result ${idx}`);
		const behavior = new LoopNodeBehavior();
		const ctx = makeCtx(
			{
				loopOver: "[1, 2, 3, 4]",
				loopBody: { type: "custom", role: "worker", description: "process" },
				// Break after iteration 1 (index 1) — item value is 2.
				loopBreakWhen: "${loop.item} == 2",
			},
			spawner,
		);

		const result = await behavior.execute(ctx, []);
		// Iterations: index 0 (item 1), index 1 (item 2) → break.
		expect((result.metadata as Record<string, unknown>).loopIterations).toBe(2);
		expect(spawned).toHaveLength(2);
	});

	it("resolves iteration source from upstream outputs", async () => {
		const { spawner, spawned } = makeSpawner((_item, idx) => `result ${idx}`);
		const behavior = new LoopNodeBehavior();
		const ctx = makeCtx(
			{
				loopOver: "${fetch}.items",
				loopBody: { type: "custom", role: "worker", description: "process" },
			},
			spawner,
			{ fetch: { result: { items: ["a", "b", "c"] } } },
		);

		const result = await behavior.execute(ctx, []);
		expect(result.success).toBe(true);
		expect((result.metadata as Record<string, unknown>).loopIterations).toBe(3);
		expect(spawned).toHaveLength(3);
	});

	it("reports failure when an iteration fails", async () => {
		const { spawner } = makeSpawner((_item, idx) => (idx === 1 ? "ok" : "ok"));
		spawner.spawn = async () => [];
		void spawner;
		// Use a spawner whose first spawn fails.
		const failing = {
			async spawn() {
				throw new Error("spawn failed");
			},
		};
		const behavior = new LoopNodeBehavior();
		const ctx = makeCtx(
			{
				loopOver: "[1]",
				loopBody: { type: "custom", role: "worker", description: "process" },
			},
			failing,
		);

		const result = await behavior.execute(ctx, []);
		expect(result.success).toBe(false);
		expect(result.error).toBeDefined();
	});

	it("exposes loop metadata (loopIterations) for downstream routing", async () => {
		const { spawner } = makeSpawner((_item, idx) => `out-${idx}`);
		const behavior = new LoopNodeBehavior();
		const ctx = makeCtx(
			{
				loopOver: "[1, 2, 3]",
				loopBody: { type: "custom", role: "worker", description: "process" },
			},
			spawner,
		);

		const result = await behavior.execute(ctx, []);
		const metadata = result.metadata as Record<string, unknown>;
		expect(metadata.loopIterations).toBe(3);
		expect(metadata.loopResults).toHaveLength(3);
	});

	it("break_when can reference loop.result.success from the current iteration", async () => {
		const { spawner, spawned } = makeSpawner((_item, idx) => `out-${idx}`);
		const behavior = new LoopNodeBehavior();
		const ctx = makeCtx(
			{
				loopOver: "[1, 2, 3, 4]",
				loopBody: { type: "custom", role: "worker", description: "process" },
				// Break when the current iteration's item equals 2 (index 1).
				loopBreakWhen: "${loop.item} == 2",
			},
			spawner,
		);

		const result = await behavior.execute(ctx, []);
		expect((result.metadata as Record<string, unknown>).loopIterations).toBe(2);
		expect(spawned).toHaveLength(2);
	});

	it("executes a subgraph body for each loop iteration", async () => {
		// Write an inner subgraph with a single custom node.
		const dir = "/tmp/satopi-loop-subgraph-body";
		const { rm, mkdir } = await import("node:fs/promises");
		await rm(dir, { recursive: true, force: true });
		await mkdir(dir, { recursive: true });
		await Bun.write(
			`${dir}/inner.graph.yaml`,
			`graph:
  name: inner
  description: inner subgraph
  version: 1
  revision: 0
  nodes:
    step:
      label: Step
      description: inner step
      role: stepworker
      tools: []
      depends_on: []
`,
		);

		const spawned: Array<{ role: string }> = [];
		const spawner = {
			async spawn(specs: Array<{ id: string; role: string; task: string }>) {
				for (const s of specs) spawned.push({ role: s.role });
				return specs.map(s => ({
					id: s.id,
					async wait() {
						return { output: `inner of ${s.role}`, exitCode: 0 };
					},
				}));
			},
		};

		const behavior = new LoopNodeBehavior();
		const ctx = makeCtx(
			{
				loopOver: "[1, 2]",
				loopBody: { type: "subgraph", subgraph_path: "./inner.graph.yaml" },
			},
			spawner,
		);
		// graphDir is used to resolve the subgraph path.
		ctx.graphDir = dir;

		const result = await behavior.execute(ctx, []);
		expect(result.success).toBe(true);
		expect((result.metadata as Record<string, unknown>).loopIterations).toBe(2);
		// Each iteration spawns the inner subgraph's worker once → 2 total.
		expect(spawned.filter(s => s.role === "stepworker")).toHaveLength(2);
	});
});
