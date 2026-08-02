// biome-ignore-all lint/suspicious/noTemplateCurlyInString: condition DSL literals in YAML
// biome-ignore-all lint/suspicious/noUselessEscapeInString: `\$` escapes `${` in YAML
import { describe, expect, it } from "bun:test";
import type { NodeExecutionContext, NodeExecutor } from "../graph-engine";
import { GraphEngine } from "../graph-engine";
import { parseGraphYaml, validateGraphDefinition } from "../schema";
import type { GraphDefinition, NodeResult } from "../types";

// ============================================================================
// Helpers
// ============================================================================

function makeExecutor(results: Record<string, NodeResult>): NodeExecutor {
	return {
		async execute(nodeId: string, _ctx: NodeExecutionContext): Promise<NodeResult> {
			return results[nodeId] ?? { nodeId, success: true, output: "(no result)" };
		},
	};
}

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

describe("conditional routing execution", () => {
	it("routes to the success target when exitCode is 0", async () => {
		const def = parseGraphYaml(`
graph:
  name: cond
  description: conditional graph
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

		const run = new Set<string>();
		const executor: NodeExecutor = {
			async execute(nodeId: string, _ctx: NodeExecutionContext): Promise<NodeResult> {
				run.add(nodeId);
				if (nodeId === "build") return { nodeId, success: true, output: "ok", exitCode: 0 };
				return { nodeId, success: true, output: "ran" };
			},
		};

		const engine = new GraphEngine({
			graph: def,
			waves: buildWaves(def),
			checkpointStore: makeCheckpoint() as never,
			graphName: "cond",
		});

		const result = await engine.run(executor);
		expect(run.has("build")).toBe(true);
		expect(run.has("deploy")).toBe(true);
		expect(run.has("rollback")).toBe(false);
		expect(result.executionErrors).toHaveLength(0);
	});

	it("routes to the default target when no condition matches", async () => {
		const def = parseGraphYaml(`
graph:
  name: cond
  description: conditional graph
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

		const run = new Set<string>();
		const executor: NodeExecutor = {
			async execute(nodeId: string, _ctx: NodeExecutionContext): Promise<NodeResult> {
				run.add(nodeId);
				if (nodeId === "build") return { nodeId, success: false, output: "failed", exitCode: 1 };
				return { nodeId, success: true, output: "ran" };
			},
		};

		const engine = new GraphEngine({
			graph: def,
			waves: buildWaves(def),
			checkpointStore: makeCheckpoint() as never,
			graphName: "cond2",
		});

		const result = await engine.run(executor);
		expect(run.has("build")).toBe(true);
		expect(run.has("deploy")).toBe(false);
		expect(run.has("rollback")).toBe(true);
		expect(result.executionErrors).toHaveLength(0);
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
