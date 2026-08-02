import { describe, expect, it } from "bun:test";
import type { NodeExecutionContext, NodeExecutor } from "../graph-engine";
import { GraphEngine } from "../graph-engine";
import { parseGraphYaml, validateGraphDefinition } from "../schema";
import type { GraphDefinition, NodeResult } from "../types";

// ============================================================================
// Subgraph — schema parsing & validation
// ============================================================================

describe("subgraph schema", () => {
	it("parses subgraph_path from YAML", () => {
		const def = parseGraphYaml(`
graph:
  name: parent
  description: parent workflow
  version: 1
  revision: 0
  nodes:
    analyze:
      label: Analyze
      description: analyze via subgraph
      type: subgraph
      subgraph_path: "./analysis.graph.yaml"
      role: analyzer
      tools: []
      depends_on: []
`);
		expect(def.nodes.analyze!.subgraph_path).toBe("./analysis.graph.yaml");
		expect(def.nodes.analyze!.type).toBe("subgraph");
		expect(validateGraphDefinition(def)).toHaveLength(0);
	});

	it("rejects subgraph nodes without subgraph_path", () => {
		const def = parseGraphYaml(`
graph:
  name: bad
  description: bad
  version: 1
  revision: 0
  nodes:
    analyze:
      label: Analyze
      description: analyze
      type: subgraph
      role: analyzer
      tools: []
      depends_on: []
`);
		const errors = validateGraphDefinition(def);
		expect(errors.some(e => e.path.includes("subgraph_path"))).toBe(true);
	});
});

// ============================================================================
// Subgraph — recursive execution with a mocked AgentSpawner
// ============================================================================

describe("subgraph execution", () => {
	it("runs a nested graph through the subgraph node", async () => {
		// Parent graph: root → analyze(subgraph) → report
		const parent = parseGraphYaml(`
graph:
  name: parent
  description: parent workflow
  version: 1
  revision: 0
  nodes:
    root:
      label: Root
      description: root node
      role: worker
      tools: []
      depends_on: []
    analyze:
      label: Analyze
      description: delegate to subgraph
      type: subgraph
      subgraph_path: "./analysis.graph.yaml"
      role: analyzer
      tools: []
      depends_on: [root]
    report:
      label: Report
      description: report node
      role: reporter
      tools: []
      depends_on: [analyze]
`);

		// The subgraph file: two custom nodes.
		const subgraphYaml = `
graph:
  name: analysis
  description: analysis subgraph
  version: 1
  revision: 0
  nodes:
    scan:
      label: Scan
      description: scan step
      role: scanner
      tools: []
      depends_on: []
    classify:
      label: Classify
      description: classify step
      role: classifier
      tools: []
      depends_on: [scan]
`;

		// Write the subgraph to a temp location and point subgraph_path at it.
		const dir = "/tmp/satopi-subgraph-test";
		const { rm, mkdir } = await import("node:fs/promises");
		await rm(dir, { recursive: true, force: true });
		await mkdir(dir, { recursive: true });
		await Bun.write(`${dir}/analysis.graph.yaml`, subgraphYaml);

		// Patch: subgraph_path is resolved relative to ctx.workspace, so create
		// a wrapper graph whose workspace is /tmp/satopi-subgraph-test.
		const parentWithWorkspace = structuredClone(parent);
		parentWithWorkspace.nodes.analyze!.subgraph_path = "./analysis.graph.yaml";

		// Track which nodes ran.
		const ran = new Set<string>();
		const spawned: Array<{ id: string; role: string; task: string }> = [];

		// Mock AgentSpawner.
		const spawner = {
			async spawn(specs: Array<{ id: string; role: string; task: string; profileId?: string }>) {
				for (const s of specs) {
					spawned.push({ id: s.id, role: s.role, task: s.task });
				}
				return specs.map(s => ({
					id: s.id,
					async wait() {
						return { output: `output of ${s.role}`, exitCode: 0 };
					},
				}));
			},
		};

		// Build the executor: parent GraphEngine delegates to a NodeExecutor
		// that wires NodeContext per node.
		const executor: NodeExecutor = {
			async execute(nodeId: string, execCtx: NodeExecutionContext): Promise<NodeResult> {
				ran.add(nodeId);
				if (nodeId === "analyze") {
					// Simulate what GraphRunner would do: select subgraph behavior.
					const { SubgraphNodeBehavior } = await import("../subgraph-behavior");
					const behavior = new SubgraphNodeBehavior();
					const ctx = {
						node: {
							id: nodeId,
							label: parentWithWorkspace.nodes.analyze!.label,
							description: parentWithWorkspace.nodes.analyze!.description,
							role: parentWithWorkspace.nodes.analyze!.role,
							profileId: undefined,
							tools: [],
							type: "subgraph",
							dependsOn: ["root"],
							subgraphPath: "./analysis.graph.yaml",
						},
						workspace: "/tmp/satopi-subgraph-test",
						modelRegistry: undefined,
						settings: undefined,
						upstreamOutputs: execCtx.upstreamOutputs,
						experience: "",
						signal: execCtx.signal,
						runtime: spawner,
						agentRegistry: { list: () => [], findByProfileId: () => undefined },
						roleAssetManager: undefined,
						profileRegistry: undefined,
						stateTracker: undefined,
						activityLogger: undefined,
					};
					await behavior.prepare(ctx as never);
					return behavior.execute(ctx as never, []);
				}
				if (nodeId === "report") {
					return { nodeId, success: true, output: "report done" };
				}
				return { nodeId, success: true, output: "root done" };
			},
		};

		const engine = new GraphEngine({
			graph: parentWithWorkspace,
			waves: buildWaves(parentWithWorkspace),
			checkpointStore: { write: () => true, recover: async () => null },
			graphName: "parent",
		});

		const result = await engine.run(executor);

		// All three parent nodes should have run.
		expect(ran.has("root")).toBe(true);
		expect(ran.has("analyze")).toBe(true);
		expect(ran.has("report")).toBe(true);

		// The subgraph's two nodes should have spawned agents.
		expect(spawned.map(s => s.role)).toContain("scanner");
		expect(spawned.map(s => s.role)).toContain("classifier");

		expect(result.executionErrors).toHaveLength(0);
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
