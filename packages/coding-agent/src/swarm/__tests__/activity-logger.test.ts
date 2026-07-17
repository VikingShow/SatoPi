/**
 * ActivityLogger unit tests.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { ActivityLogger, type ActivityEntry, type ActivityBroadcaster } from "../activity-logger";

describe("ActivityLogger", () => {
	let tmpDir: string;
	let logger: ActivityLogger;

	beforeEach(async () => {
		tmpDir = path.join(os.tmpdir(), `activity-test-${Date.now()}`);
		await fs.mkdir(tmpDir, { recursive: true });
		logger = new ActivityLogger(tmpDir);
	});

	it("writes broadcast events to activity.jsonl", async () => {
		logger.logBroadcast("worker-1", "I'll handle auth");
		// Wait for write queue to flush
		await new Promise((r) => setTimeout(r, 100));

		const content = await fs.readFile(path.join(tmpDir, "activity.jsonl"), "utf-8");
		const lines = content.trim().split("\n");
		expect(lines.length).toBe(1);

		const entry = JSON.parse(lines[0]) as ActivityEntry;
		expect(entry.type).toBe("broadcast");
		expect(entry.from).toBe("worker-1");
		expect(entry.to).toBe("all");
		expect(entry.body).toBe("I'll handle auth");
		expect(entry.ts).toBeGreaterThan(0);
	});

	it("writes subgroup events", async () => {
		logger.logSubGroup("auth-team", "worker-1", "need help with JWT");
		await new Promise((r) => setTimeout(r, 100));

		const content = await fs.readFile(path.join(tmpDir, "activity.jsonl"), "utf-8");
		const entry = JSON.parse(content.trim()) as ActivityEntry;
		expect(entry.type).toBe("subgroup");
		expect(entry.to).toBe("auth-team");
	});

	it("writes steering events", async () => {
		logger.logSteering("cloner-1", "worker-2", "focus on edge cases");
		await new Promise((r) => setTimeout(r, 100));

		const content = await fs.readFile(path.join(tmpDir, "activity.jsonl"), "utf-8");
		const entry = JSON.parse(content.trim()) as ActivityEntry;
		expect(entry.type).toBe("steering");
		expect(entry.from).toBe("cloner-1");
		expect(entry.to).toBe("worker-2");
	});

	it("writes phase events", async () => {
		logger.logPhase("workers", 2, 1);
		await new Promise((r) => setTimeout(r, 100));

		const content = await fs.readFile(path.join(tmpDir, "activity.jsonl"), "utf-8");
		const entry = JSON.parse(content.trim()) as ActivityEntry;
		expect(entry.type).toBe("phase");
		expect(entry.phase).toBe("workers");
		expect(entry.round).toBe(2);
		expect(entry.iteration).toBe(1);
	});

	it("writes verdict events with all fields", async () => {
		logger.logVerdict({
			passed: false,
			approvalCount: 1,
			totalCount: 3,
			findings: ["missing validation", "no error handling"],
			workerCountSuggestions: [1],
			disagreed: false,
			roleSuggestions: {},
			praisedWorkers: ["worker-1"],
			criticizedWorkers: ["worker-3"],
		});
		await new Promise((r) => setTimeout(r, 100));

		const content = await fs.readFile(path.join(tmpDir, "activity.jsonl"), "utf-8");
		const entry = JSON.parse(content.trim()) as ActivityEntry;
		expect(entry.type).toBe("verdict");
		expect(entry.passed).toBe(false);
		expect(entry.approval).toBe(1);
		expect(entry.total).toBe(3);
		expect(entry.findings).toEqual(["missing validation", "no error handling"]);
		expect(entry.praised).toEqual(["worker-1"]);
		expect(entry.criticized).toEqual(["worker-3"]);
	});

	it("writes conflict events", async () => {
		logger.logConflict("src/auth.ts", ["worker-1", "worker-2"], "overlap");
		await new Promise((r) => setTimeout(r, 100));

		const content = await fs.readFile(path.join(tmpDir, "activity.jsonl"), "utf-8");
		const entry = JSON.parse(content.trim()) as ActivityEntry;
		expect(entry.type).toBe("conflict");
		expect(entry.file).toBe("src/auth.ts");
		expect(entry.writers).toEqual(["worker-1", "worker-2"]);
		expect(entry.severity).toBe("overlap");
	});

	it("writes scaling events", async () => {
		logger.logScaling("add", "worker-4", "cloner suggestion +1");
		await new Promise((r) => setTimeout(r, 100));

		const content = await fs.readFile(path.join(tmpDir, "activity.jsonl"), "utf-8");
		const entry = JSON.parse(content.trim()) as ActivityEntry;
		expect(entry.type).toBe("scaling");
		expect(entry.action).toBe("add");
		expect(entry.worker).toBe("worker-4");
	});

	it("writes nomination events", async () => {
		logger.logNomination(1, "worker-1", { "worker-1": ["worker-2", "worker-3"] });
		await new Promise((r) => setTimeout(r, 100));

		const content = await fs.readFile(path.join(tmpDir, "activity.jsonl"), "utf-8");
		const entry = JSON.parse(content.trim()) as ActivityEntry;
		expect(entry.type).toBe("nomination");
		expect(entry.elected).toBe("worker-1");
		expect(entry.votes).toEqual({ "worker-1": ["worker-2", "worker-3"] });
	});

	it("writes crash events", async () => {
		logger.logCrash("worker-3", "signal SIGTERM");
		await new Promise((r) => setTimeout(r, 100));

		const content = await fs.readFile(path.join(tmpDir, "activity.jsonl"), "utf-8");
		const entry = JSON.parse(content.trim()) as ActivityEntry;
		expect(entry.type).toBe("crash");
		expect(entry.worker).toBe("worker-3");
		expect(entry.error).toBe("signal SIGTERM");
	});

	it("pushes events to broadcaster when set", async () => {
		const received: ActivityEntry[] = [];
		const broadcaster: ActivityBroadcaster = {
			broadcast(entry: ActivityEntry) {
				received.push(entry);
			},
		};
		logger.setBroadcaster(broadcaster);

		logger.logBroadcast("worker-1", "test message");
		await new Promise((r) => setTimeout(r, 100));

		expect(received.length).toBe(1);
		expect(received[0].type).toBe("broadcast");
		expect(received[0].body).toBe("test message");
	});

	it("preserves event ordering in file", async () => {
		logger.logBroadcast("w1", "first");
		logger.logBroadcast("w2", "second");
		logger.logBroadcast("w3", "third");
		await new Promise((r) => setTimeout(r, 500));

		const content = await fs.readFile(path.join(tmpDir, "activity.jsonl"), "utf-8");
		const lines = content.trim().split("\n");
		expect(lines.length).toBe(3);
		expect(JSON.parse(lines[0]).body).toBe("first");
		expect(JSON.parse(lines[1]).body).toBe("second");
		expect(JSON.parse(lines[2]).body).toBe("third");
	});

	it("does not crash when broadcaster throws", async () => {
		const badBroadcaster: ActivityBroadcaster = {
			broadcast() {
				throw new Error("SSE connection closed");
			},
		};
		logger.setBroadcaster(badBroadcaster);

		// Should not throw
		logger.logBroadcast("worker-1", "test");
		await new Promise((r) => setTimeout(r, 100));

		// File should still be written
		const content = await fs.readFile(path.join(tmpDir, "activity.jsonl"), "utf-8");
		expect(content.trim().split("\n")).toHaveLength(1);
	});
});
