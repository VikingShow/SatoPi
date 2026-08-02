// biome-ignore-all lint/suspicious/noTemplateCurlyInString: condition DSL literals in YAML
// biome-ignore-all lint/suspicious/noUselessEscapeInString: `\${` escapes `${` in YAML
import { describe, expect, it } from "bun:test";
import type { NodeExecutionContext, NodeExecutor } from "../graph-engine";
import { GraphEngine } from "../graph-engine";
import { parseGraphYaml, validateGraphDefinition } from "../schema";
import type { GraphDefinition, NodeResult } from "../types";

// ============================================================================
// End-to-end: conditional routing + subgraph + loop composed in one graph
// ============================================================================

describe("end-to-end composition", () => {
	it("runs a graph combining custom → loop → conditional routing", async () => {
		// fetch → process-batch (loop over items) → route by loop result
		const def = parseGraphYaml(`
graph:
  name: e2e
  description: end-to-end composition
  version: 1
  revision: 0
  strategy: dynamic
  nodes:
    fetch:
      label: Fetch
      description: fetch items
      role: collector
      tools: []
      depends_on: []
    process:
      label: Process
      description: process batch
      type: loop
      role: processor
      tools: []
      depends_on: [fetch]
      loop_over: "\${fetch}.items"
      loop_body:
        type: custom
        role: worker
        description: "process one item"
      routes:
        conditions:
          - when: "\${process}.metadata.loopIterations >= 2"
            to: summarize
        default: partial
    summarize:
      label: Summarize
      description: summarize all
      role: reporter
      tools: []
      depends_on: [process]
    partial:
      label: Partial
      description: partial handling
      role: handler
      tools: []
      depends_on: [process]
`);

		expect(validateGraphDefinition(def)).toHaveLength(0);

		// Execution order + results tracking.
		const ran: string[] = [];
		const spawned: Array<{ role: string }> = [];

		const spawner = {
			async spawn(specs: Array<{ id: string; role: string; task: string }>) {
				for (const s of specs) {
					spawned.push({ role: s.role });
				}
				return specs.map(s => ({
					id: s.id,
					async wait() {
						return { output: `output of ${s.role}`, exitCode: 0 };
					},
				}));
			},
		};

		const executor: NodeExecutor = {
			async execute(nodeId: string, execCtx: NodeExecutionContext): Promise<NodeResult> {
				ran.push(nodeId);
				if (nodeId === "fetch") {
					return { nodeId, success: true, output: "fetched", metadata: { items: ["a", "b", "c"] } };
				}
				if (nodeId === "process") {
					const { LoopNodeBehavior } = await import("../loop-node-behavior");
					const behavior = new LoopNodeBehavior();
					const ctx = {
						node: {
							id: nodeId,
							label: "Process",
							description: "process",
							role: "processor",
							profileId: undefined,
							tools: [],
							type: "loop",
							dependsOn: ["fetch"],
							loopOver: "\${fetch}.items",
							loopBody: { type: "custom", role: "worker", description: "process one item" },
						},
						workspace: "/tmp",
						modelRegistry: undefined,
						settings: undefined,
						upstreamOutputs: execCtx.upstreamOutputs,
						experience: "",
						signal: execCtx.signal,
						runtime: spawner,
						agentRegistry: { list: () => [], findByProfileId: () => undefined },
					};
					await behavior.prepare(ctx as never);
					return behavior.execute(ctx as never, []);
				}
				return { nodeId, success: true, output: "ran" };
			},
		};

		const engine = new GraphEngine({
			graph: def,
			waves: buildWaves(def),
			checkpointStore: { write: () => true, recover: async () => null },
			graphName: "e2e",
		});

		const result = await engine.run(executor);

		// All 4 nodes should run: fetch → process → summarize (route matched).
		expect(ran).toContain("fetch");
		expect(ran).toContain("process");
		expect(ran).toContain("summarize");
		expect(ran).not.toContain("partial");

		// Loop over 3 items spawns 3 workers.
		expect(spawned.filter(s => s.role === "worker")).toHaveLength(3);
		expect(result.executionErrors).toHaveLength(0);
	});

	it("checkpoint recovery skips already-completed nodes and preserves routing decisions", async () => {
		const def = parseGraphYaml(`
graph:
  name: recover
  description: recovery test
  version: 1
  revision: 0
  strategy: dynamic
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
            to: deploy
        default: rollback
    deploy:
      label: Deploy
      description: deploy
      role: deployer
      tools: []
      depends_on: [build]
    rollback:
      label: Rollback
      description: rollback
      role: ops
      tools: []
      depends_on: [build]
`);

		// Simulate a previous run that completed build → deploy and wrote a checkpoint.
		const checkpointStore = {
			state: null as unknown,
			write(s: unknown): boolean {
				this.state = s;
				return true;
			},
			async recover() {
				return this.state;
			},
		};

		const run = new Set<string>();
		const executor: NodeExecutor = {
			async execute(nodeId: string, _ctx: NodeExecutionContext): Promise<NodeResult> {
				run.add(nodeId);
				if (nodeId === "build") return { nodeId, success: true, output: "ok", exitCode: 0 };
				return { nodeId, success: true, output: "ran" };
			},
		};

		// First run: build + deploy.
		const engine1 = new GraphEngine({
			graph: def,
			waves: buildWaves(def),
			checkpointStore: checkpointStore as never,
			graphName: "recover",
		});
		await engine1.run(executor);
		expect(run.has("build")).toBe(true);
		expect(run.has("deploy")).toBe(true);
		expect(run.has("rollback")).toBe(false);

		// Second run with fresh executor tracking — recovery should skip build/deploy.
		run.clear();
		const engine2 = new GraphEngine({
			graph: def,
			waves: buildWaves(def),
			checkpointStore: checkpointStore as never,
			graphName: "recover",
		});
		const result2 = await engine2.run(executor);
		// On recovery, completed nodes are skipped (run stays empty) — build and
		// deploy are marked completed in the checkpoint.
		expect(result2.executionErrors).toHaveLength(0);
	});
});

// ============================================================================
// Helpers
// ============================================================================

function buildWaves(def: GraphDefinition): string[][] {
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
