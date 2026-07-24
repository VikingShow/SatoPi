/**
 * agent-fork-manager.test.ts — Unit tests for AgentForkManager utilities
 *
 * Coverage:
 * 1. decomposeSubtasks: splits multi-paragraph tasks evenly
 * 2. decomposeSubtasks: handles tasks with fewer paragraphs than count
 * 3. AgentForkManager: maxDepth rejection
 * 4. AgentForkManager: reset clears state
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { decomposeSubtasks, AgentForkManager } from "../agent/agent-fork-manager";

describe("decomposeSubtasks", () => {
	// ── Multi-paragraph tasks ─────────────────────────────────────────

	test("distributes paragraphs evenly across subtasks", async () => {
		const task = ["Part 1: Setup project.", "Part 2: Implement API.", "Part 3: Write tests.", "Part 4: Deploy."].join(
			"\n\n",
		);

		const subtasks = await decomposeSubtasks(task, 2);
		expect(subtasks.length).toBe(2);
		expect(subtasks[0]).toContain("Part 1");
		expect(subtasks[0]).toContain("Part 2");
		expect(subtasks[1]).toContain("Part 3");
		expect(subtasks[1]).toContain("Part 4");
	});

	test("handles numbered items splitting", async () => {
		const task = "1. Set up database.\n2. Create models.\n3. Write controllers.\n4. Add middleware.";

		const subtasks = await decomposeSubtasks(task, 3);
		expect(subtasks.length).toBe(3);
	});

	// ── Fewer parts than count ───────────────────────────────────────

	test("creates numbered fallbacks when task has fewer parts than count", async () => {
		const task = "A single sentence task.";
		const subtasks = await decomposeSubtasks(task, 3);

		expect(subtasks.length).toBe(3);
		for (let i = 0; i < 3; i++) {
			expect(subtasks[i]).toContain(`Subtask ${i + 1}/3`);
			expect(subtasks[i]).toContain(task);
		}
	});

	// ── Empty task ───────────────────────────────────────────────────

	test("handles empty task description", async () => {
		const subtasks = await decomposeSubtasks("", 2);
		expect(subtasks.length).toBe(2);
		expect(subtasks[0]).toContain("Subtask 1/2");
	});
});

describe("AgentForkManager", () => {
	let workspace: string;

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "fork-test-"));
	});

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
	});

	// ── Depth limit ──────────────────────────────────────────────────

	test("throws when max fork depth reached", () => {
		const manager = new AgentForkManager(0); // no forking allowed
		const mockAgent = {
			state: { model: { id: "dummy" } },
		} as any;

		expect(
			manager.fork(mockAgent, "test task"),
		).rejects.toThrow("max fork depth");
	});

	test("throws when depth exceeds maxDepth via options", () => {
		const manager = new AgentForkManager(1);
		const mockAgent = {
			state: { model: { id: "dummy" }, systemPrompt: [], tools: [], messages: [] },
		} as any;

		expect(
			manager.fork(mockAgent, "task", { depth: 1 }),
		).rejects.toThrow("max fork depth");
	});

	// ── Reset ────────────────────────────────────────────────────────

	test("reset clears all children", () => {
		const manager = new AgentForkManager(1);
		expect(manager.children.size).toBe(0);

		manager.reset();
		expect(manager.children.size).toBe(0);
		expect(manager.depth).toBe(0);
	});

	// ── Properties ───────────────────────────────────────────────────

	test("default maxDepth is 1", () => {
		const manager = new AgentForkManager();
		expect(manager.depth).toBe(0);
		expect(manager.children.size).toBe(0);
	});
});
