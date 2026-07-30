/**
 * Phase 9A Smoke Tests — Cross-verification: agent_invoke, agent://, GraphEngine.
 *
 * Three independent critical-path smoke tests:
 *  1. agent_invoke — spawn/steer a persistent agent session
 *  2. agent://   — resolve an agent output URI end-to-end
 *  3. GraphEngine — standalone 2-node DAG execution with a mock NodeExecutor
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TextContent } from "@satopi/pi-ai";
import { TempDir } from "@satopi/pi-utils";
import { ProfileRegistry } from "../../agent/agent-profile";
import { AgentProtocolHandler } from "../../internal-urls/agent-protocol";
import { parseInternalUrl } from "../../internal-urls/parse";
import { resetRegisteredArtifactDirsForTests } from "../../internal-urls/registry-helpers";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import { buildExecutionWaves } from "../../swarm/core/dag";
import type { CheckpointStore } from "../checkpoint";
import type { NodeExecutionContext } from "../graph-engine";
import { GraphEngine } from "../graph-engine";
import type { GraphDefinition, GraphRunState, NodeExecutionOutput, NodeResult } from "../types";

// ============================================================================
// 1. agent_invoke smoke test — mock pattern mirrors existing E2E tests
// ============================================================================

const mockCreateAgentSession = mock();

mock.module("../../sdk", () => ({
	createAgentSession: mockCreateAgentSession,
}));

import { agentInvokeTool } from "../../tools/agent-invoke";

// Helper: make a session-shaped mock
function makeSession(output: string, exitCode = 0) {
	return {
		prompt: mock().mockResolvedValue(true),
		wait: mock().mockResolvedValue({ output, exitCode }),
	};
}

// Helper: create a profile
function createProfile(id: string) {
	ProfileRegistry.global().createProfile({
		profileId: id,
		name: `${id} Agent`,
		archetype: "worker",
	});
}

describe("Phase 9A: Smoke Tests", () => {
	// ==================================================================
	// 1. agent_invoke
	// ==================================================================
	describe("1. agent_invoke", () => {
		afterEach(() => {
			mock.restore();
			for (const ref of AgentRegistry.global().list()) {
				AgentRegistry.global().unregister(ref.id);
			}
			ProfileRegistry.resetGlobalForTests();
			mockCreateAgentSession.mockClear();
		});

		it("smoke: spawns a new persistent agent session and returns output", async () => {
			createProfile("smoke-worker");
			const session = makeSession("Smoke test task completed successfully");
			mockCreateAgentSession.mockResolvedValue({ session });

			const result = await agentInvokeTool.execute("call-1", { profileId: "smoke-worker", task: "Run smoke test" });

			expect(result.isError).toBe(false);
			expect((result.content[0] as TextContent).text).toContain("Smoke test task completed successfully");
			expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
			expect(session.prompt).toHaveBeenCalledWith("Run smoke test");
		});

		it("smoke: steers an existing idle persistent agent", async () => {
			createProfile("steer-worker");
			const session = makeSession("Steered task done");
			AgentRegistry.global().register({
				id: "persist-steer-worker",
				displayName: "persist-steer-worker",
				kind: "main",
				profileId: "steer-worker",
				session: session as unknown as AgentSession,
				status: "idle",
			});

			const result = await agentInvokeTool.execute("call-2", { profileId: "steer-worker", task: "Steer me" });

			expect(result.isError).toBe(false);
			expect((result.content[0] as TextContent).text).toContain("Steered task done");
			expect(mockCreateAgentSession).not.toHaveBeenCalled();
			expect(session.prompt).toHaveBeenCalledWith("Steer me");
		});

		it("smoke: reports error on session creation failure", async () => {
			createProfile("fail-worker");
			mockCreateAgentSession.mockRejectedValue(new Error("Connection refused"));

			const result = await agentInvokeTool.execute("call-3", { profileId: "fail-worker", task: "Will fail" });

			expect(result.isError).toBe(true);
			expect((result.content[0] as TextContent).text).toContain("Connection refused");
		});
	});

	// ==================================================================
	// 2. agent:// resolution
	// ==================================================================
	describe("2. agent:// resolution", () => {
		const tempDir = TempDir.createSync("stp-smoke-agent-uri-");

		afterEach(() => {
			resetRegisteredArtifactDirsForTests();
			for (const ref of AgentRegistry.global().list()) {
				AgentRegistry.global().unregister(ref.id);
			}
		});

		function makeSessionObj(dir: string): AgentSession {
			return {
				sessionManager: { getArtifactsDir: () => dir },
			} as unknown as AgentSession;
		}

		it("smoke: resolves agent://<id> to artifact content", async () => {
			const dir = tempDir.path();
			await fs.mkdir(dir, { recursive: true });

			const outputId = "SmokeReporter";
			const content = '{"status":"ok","summary":"Smoke test agent completed",' + '"data":{"files":3,"lines":120}}';
			await fs.writeFile(path.join(dir, `${outputId}.md`), content);

			AgentRegistry.global().register({
				id: "Main1",
				displayName: "main",
				kind: "main",
				session: makeSessionObj(dir),
				sessionFile: path.join(dir, "session.jsonl"),
			});

			const handler = new AgentProtocolHandler();
			const resource = await handler.resolve(parseInternalUrl(`agent://${outputId}`));

			expect(resource.content).toBe(content);
			expect(resource.contentType).toBe("text/markdown");
		});

		it("smoke: resolves agent://<id>/<path> for JSON extraction", async () => {
			const dir = tempDir.path();
			await fs.mkdir(dir, { recursive: true });

			await fs.writeFile(path.join(dir, "SmokeJson.md"), '{"status":"ok","summary":"All good","data":{"count":42}}');

			AgentRegistry.global().register({
				id: "Main2",
				displayName: "main",
				kind: "main",
				session: makeSessionObj(dir),
			});

			const handler = new AgentProtocolHandler();
			const resource = await handler.resolve(parseInternalUrl("agent://SmokeJson/data"));

			const parsed = JSON.parse(resource.content);
			expect(parsed.count).toBe(42);
			expect(resource.contentType).toBe("application/json");
		});

		it("smoke: throws on missing output ID", async () => {
			const dir = tempDir.path();
			await fs.mkdir(dir, { recursive: true });

			AgentRegistry.global().register({
				id: "Main3",
				displayName: "main",
				kind: "main",
				session: makeSessionObj(dir),
			});

			const handler = new AgentProtocolHandler();
			await expect(handler.resolve(parseInternalUrl("agent://nonexistent-xyz"))).rejects.toThrow(
				/Not found: nonexistent-xyz/,
			);
		});
	});

	// ==================================================================
	// 3. GraphEngine standalone
	// ==================================================================
	describe("3. GraphEngine standalone", () => {
		class InMemoryCheckpointStore implements CheckpointStore {
			readonly #store = new Map<string, GraphRunState>();

			write(state: GraphRunState): boolean {
				this.#store.set(state.graphName, state);
				return true;
			}

			async recover(graphName: string): Promise<GraphRunState | null> {
				return this.#store.get(graphName) ?? null;
			}
		}

		/** Build waves + engine for a graph def in one call. */
		function buildEngine(def: GraphDefinition, graphName?: string): GraphEngine {
			const deps = new Map<string, Set<string>>();
			for (const [id, node] of Object.entries(def.nodes)) {
				deps.set(id, new Set(node.depends_on));
			}
			return new GraphEngine({
				graph: def,
				waves: buildExecutionWaves(deps),
				checkpointStore: new InMemoryCheckpointStore(),
				graphName: graphName ?? def.name,
			});
		}

		/** Simple executor that logs order. */
		function trackingExecutor(order: string[]) {
			return {
				execute(nodeId: string): Promise<NodeResult> {
					order.push(nodeId);
					return Promise.resolve({ nodeId, success: true, output: `Executed ${nodeId}` });
				},
			};
		}

		it("smoke: runs a 2-node sequential graph to completion", async () => {
			const engine = buildEngine({
				name: "smoke-test",
				description: "Simple 2-node smoke test graph",
				version: 1,
				revision: 1,
				nodes: {
					scout: {
						label: "Scout",
						description: "Explores",
						role: "scout",
						tools: [],
						depends_on: [],
					},
					worker: {
						label: "Worker",
						description: "Implements",
						role: "worker",
						tools: [],
						depends_on: ["scout"],
					},
				},
			});

			const order: string[] = [];
			const result = await engine.run(trackingExecutor(order));

			expect(result.completedCount).toBe(2);
			expect(result.totalNodes).toBe(2);
			expect(result.executionErrors).toEqual([]);
			expect(order).toEqual(["scout", "worker"]);
		});

		it("smoke: 3-node diamond graph executes in correct waves", async () => {
			const engine = buildEngine({
				name: "diamond-test",
				description: "Diamond",
				version: 1,
				revision: 1,
				nodes: {
					a: { label: "A", description: "", role: "scout", tools: [], depends_on: [] },
					b: { label: "B", description: "", role: "worker", tools: [], depends_on: ["a"] },
					c: { label: "C", description: "", role: "worker", tools: [], depends_on: ["a", "b"] },
				},
			});

			const order: string[] = [];
			const result = await engine.run(trackingExecutor(order));

			expect(result.completedCount).toBe(3);
			expect(result.totalNodes).toBe(3);
			expect(result.executionErrors).toEqual([]);
			// Waves: a in wave 0, b in wave 1, c in wave 2
			expect(order).toEqual(["a", "b", "c"]);
		});

		it("smoke: reports failure when a node executor throws", async () => {
			const engine = buildEngine({
				name: "failure-test",
				description: "Failure",
				version: 1,
				revision: 1,
				nodes: {
					a: { label: "A", description: "", role: "scout", tools: [], depends_on: [] },
				},
			});

			const result = await engine.run({
				execute(_nodeId: string): Promise<NodeResult> {
					throw new Error("Simulated node crash");
				},
			});

			// The node still appears in nodeResults (error result is stored),
			// but completedCount counts all nodes that ran to a result.
			// The executionErrors array captures the abort message.
			expect(result.totalNodes).toBe(1);
			expect(result.executionErrors).toHaveLength(1);
			expect(result.executionErrors[0]).toContain("Simulated node crash");
		});

		it("smoke: parallel-wave nodes can execute concurrently", async () => {
			const engine = buildEngine({
				name: "parallel-test",
				description: "Parallel",
				version: 1,
				revision: 1,
				nodes: {
					s1: { label: "S1", description: "", role: "scout", tools: [], depends_on: [] },
					s2: { label: "S2", description: "", role: "scout", tools: [], depends_on: [] },
				},
			});

			const result = await engine.run(trackingExecutor([]));

			expect(result.completedCount).toBe(2);
			expect(result.totalNodes).toBe(2);
			expect(result.executionErrors).toEqual([]);
		});

		it("smoke: upstream outputs are passed to downstream nodes", async () => {
			const engine = buildEngine({
				name: "upstream-test",
				description: "Upstream",
				version: 1,
				revision: 1,
				nodes: {
					producer: {
						label: "Producer",
						description: "",
						role: "worker",
						tools: [],
						depends_on: [],
					},
					consumer: {
						label: "Consumer",
						description: "",
						role: "worker",
						tools: [],
						depends_on: ["producer"],
					},
				},
			});

			let consumerUpstream: Record<string, NodeExecutionOutput> | undefined;

			await engine.run({
				execute(nodeId: string, execCtx: NodeExecutionContext): Promise<NodeResult> {
					if (nodeId === "consumer") {
						consumerUpstream = execCtx.upstreamOutputs;
					}
					return Promise.resolve({ nodeId, success: true, output: `Ran ${nodeId}` });
				},
			});

			expect(consumerUpstream).toBeDefined();
			expect(consumerUpstream?.producer).toBeDefined();
			expect(consumerUpstream?.producer.nodeId).toBe("producer");
			expect(consumerUpstream?.producer.summary).toContain("Ran producer");
		});
	});
});
