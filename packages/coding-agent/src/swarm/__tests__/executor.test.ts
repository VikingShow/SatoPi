import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { StateTracker } from "../core/state";
import { executeSwarmAgent } from "../executor/executor";

let workspace: string;

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-test-"));
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(workspace, { recursive: true, force: true });
});

describe("executeSwarmAgent", () => {
	it("throws when runtime is not provided (no legacy fallback)", async () => {
		const mockModelRegistry = {
			authStorage: { discover: vi.fn() },
		} as unknown as ModelRegistry;

		const stateTracker = new StateTracker(workspace, "test-swarm");
		await stateTracker.init(["test-agent"], 1, "parallel");

		const agent = {
			name: "test-agent",
			role: "tester",
			task: "do something",
			reportsTo: [],
			waitsFor: [],
		};

		await expect(
			executeSwarmAgent(agent, 0, {
				workspace,
				swarmName: "test-swarm",
				iteration: 0,
				modelRegistry: mockModelRegistry,
				stateTracker,
			}),
		).rejects.toThrow("AgentRuntime is required for swarm agent execution");
	});
});
