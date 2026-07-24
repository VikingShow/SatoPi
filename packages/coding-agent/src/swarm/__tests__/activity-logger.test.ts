/**
 * ActivityLogger unit tests — verifies event capture via SwarmSessionManager.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import { ActivityLogger, type ActivityEntry, type ActivityBroadcaster } from "../activity-logger";
import { SwarmSessionManager } from "../swarm-session-manager";

describe("ActivityLogger", () => {
	let tmpDir: string;
	let logger: ActivityLogger;
	let sm: SwarmSessionManager;

	beforeEach(async () => {
		tmpDir = path.join(os.tmpdir(), `activity-test-${Date.now()}`);
		sm = await SwarmSessionManager.create(tmpDir);
		logger = new ActivityLogger(tmpDir, "test-session");
		logger.setSessionManager(sm);
	});

	afterEach(async () => {
		try { await sm.close(); } catch { /* cleanup */ }
	});

	/** Helper: flush session manager then read activity entries. */
	async function readEntries(): Promise<ActivityEntry[]> {
		await sm.flush();
		return SwarmSessionManager.readActivityEntries(tmpDir);
	}

	it("writes broadcast events to session.jsonl", async () => {
		logger.logBroadcast("worker-1", "I'll handle auth");

		const entries = await readEntries();
		expect(entries.length).toBe(1);

		const entry = entries[0];
		expect(entry.type).toBe("broadcast");
		expect(entry.from).toBe("worker-1");
		expect(entry.to).toBe("all");
		expect(entry.body).toBe("I'll handle auth");
		expect(entry.ts).toBeGreaterThan(0);
	});

	it("writes subgroup events", async () => {
		logger.logSubGroup("auth-team", "worker-1", "need help with JWT");

		const entries = await readEntries();
		const entry = entries[0];
		expect(entry.type).toBe("subgroup");
		expect(entry.to).toBe("auth-team");
	});

	it("writes steering events", async () => {
		logger.logSteering("cloner-1", "worker-2", "focus on edge cases");

		const entries = await readEntries();
		expect(entries[0].type).toBe("steering");
		expect(entries[0].from).toBe("cloner-1");
		expect(entries[0].to).toBe("worker-2");
	});

	it("writes phase events", async () => {
		logger.logPhase("workers", 2, 1);

		const entries = await readEntries();
		expect(entries[0].type).toBe("phase");
		expect(entries[0].phase).toBe("workers");
		expect(entries[0].round).toBe(2);
		expect(entries[0].iteration).toBe(1);
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
			praisedAgents: ["worker-1"],
			criticizedAgents: ["worker-3"],
		});

		const entries = await readEntries();
		expect(entries[0].type).toBe("verdict");
		expect(entries[0].passed).toBe(false);
		expect(entries[0].approval).toBe(1);
		expect(entries[0].total).toBe(3);
		expect(entries[0].findings).toEqual(["missing validation", "no error handling"]);
		expect(entries[0].praised).toEqual(["worker-1"]);
		expect(entries[0].criticized).toEqual(["worker-3"]);
	});

	it("writes conflict events", async () => {
		logger.logConflict("src/auth.ts", ["worker-1", "worker-2"], "overlap");

		const entries = await readEntries();
		expect(entries[0].type).toBe("conflict");
		expect(entries[0].file).toBe("src/auth.ts");
		expect(entries[0].writers).toEqual(["worker-1", "worker-2"]);
		expect(entries[0].severity).toBe("overlap");
	});

	it("writes scaling events", async () => {
		logger.logScaling("add", "worker-4", "cloner suggestion +1");

		const entries = await readEntries();
		expect(entries[0].type).toBe("scaling");
		expect(entries[0].action).toBe("add");
		expect(entries[0].agent).toBe("worker-4");
	});

	it("writes nomination events", async () => {
		logger.logNomination(1, "worker-1", { "worker-1": ["worker-2", "worker-3"] });

		const entries = await readEntries();
		expect(entries[0].type).toBe("nomination");
		expect(entries[0].elected).toBe("worker-1");
		expect(entries[0].votes).toEqual({ "worker-1": ["worker-2", "worker-3"] });
	});

	it("writes crash events", async () => {
		logger.logCrash("worker-3", "signal SIGTERM");

		const entries = await readEntries();
		expect(entries[0].type).toBe("crash");
		expect(entries[0].agentName).toBe("worker-3");
		expect(entries[0].error).toBe("signal SIGTERM");
	});

	it("pushes events to broadcaster when set", async () => {
		const received: ActivityEntry[] = [];
		const broadcaster: ActivityBroadcaster = {
			broadcast(_sessionName: string, entry: ActivityEntry) {
				received.push(entry);
			},
		};
		logger.setBroadcaster(broadcaster);

		logger.logBroadcast("worker-1", "test message");

		const entries = await readEntries();
		expect(received.length).toBe(1);
		expect(received[0].type).toBe("broadcast");
		expect(received[0].body).toBe("test message");
		expect(entries.length).toBe(1);
	});

	it("preserves event ordering in session", async () => {
		logger.logBroadcast("w1", "first");
		logger.logBroadcast("w2", "second");
		logger.logBroadcast("w3", "third");

		const entries = await readEntries();
		expect(entries.length).toBe(3);
		expect(entries[0].body).toBe("first");
		expect(entries[1].body).toBe("second");
		expect(entries[2].body).toBe("third");
	});

	it("does not crash when broadcaster throws", async () => {
		const badBroadcaster: ActivityBroadcaster = {
			broadcast(_sessionName: string, _entry: ActivityEntry) {
				throw new Error("SSE connection closed");
			},
		};
		logger.setBroadcaster(badBroadcaster);

		// Should not throw
		logger.logBroadcast("worker-1", "test");

		const entries = await readEntries();
		// Entry should still be persisted even though SSE broadcast failed
		expect(entries).toHaveLength(1);
	});

	it("does not crash when sessionManager is not set", async () => {
		const bareLogger = new ActivityLogger(tmpDir, "bare");
		// Should not throw — events are SSE-only
		bareLogger.logBroadcast("worker-1", "no persistence");

		const entries = await SwarmSessionManager.readActivityEntries(tmpDir);
		expect(entries.length).toBe(0); // nothing persisted
	});
});
