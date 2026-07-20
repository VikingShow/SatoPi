/**
 * MonitorServer integration tests.
 *
 * Tests the HTTP server, SSE streaming, and REST API endpoints.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { StateTracker } from "../state";
import { MonitorServer } from "../monitor/server";
import { ActivityLogger } from "../activity-logger";
import type { ActivityEntry } from "../activity-logger";
import { SwarmSessionManager } from "../swarm-session-manager";

describe("MonitorServer", () => {
	let tmpDir: string;
	let stateTracker: StateTracker;
	let server: MonitorServer;
	let port: number;

	beforeEach(async () => {
		tmpDir = path.join(os.tmpdir(), `monitor-test-${Date.now()}`);
		await fs.mkdir(tmpDir, { recursive: true });
		stateTracker = new StateTracker(tmpDir, "test-swarm");
		await stateTracker.init(["worker-1", "worker-2"], 5, "loop");

		const yamlPath = path.join(tmpDir, "loop.yaml");
		await fs.writeFile(yamlPath, "name: test-swarm\nmode: loop\n");

		server = new MonitorServer(stateTracker, tmpDir, yamlPath);
		port = server.start(20000 + Math.floor(Math.random() * 1000));
	});

	afterEach(() => {
		server?.stop();
	});

	it("starts and listens on the specified port", () => {
		expect(server.isRunning).toBe(true);
		expect(port).toBeGreaterThanOrEqual(17878);
	});

	it("responds to GET /api/state with SwarmState", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/state`);
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.name).toBe("test-swarm");
		expect(data.mode).toBe("loop");
		expect(data.status).toBe("running");
		expect(data.agents["worker-1"]).toBeDefined();
	});

	it("responds to GET /api/config with YAML content", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/config`);
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.yaml).toContain("name: test-swarm");
		expect(data.yaml).toContain("mode: loop");
	});

	it("handles PUT /api/config to update YAML", async () => {
		const newYaml = "name: updated-swarm\nmode: loop\n";
		const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ yaml: newYaml }),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.success).toBe(true);

		// Verify file was written
		const content = await fs.readFile(path.join(tmpDir, "loop.yaml"), "utf-8");
		expect(content).toBe(newYaml);
	});

	it("streams SSE events when ActivityLogger broadcasts", async () => {
		const logger = new ActivityLogger(stateTracker.swarmDir, "test");
		logger.setBroadcaster(server);

		// Connect to SSE using fetch (EventSource not available in Bun test env)
		const res = await fetch(`http://127.0.0.1:${port}/events`);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");

		const reader = res.body?.getReader();
		expect(reader).toBeDefined();

		const received: ActivityEntry[] = [];
		const decoder = new TextDecoder();

		// Wait for connection, then emit events
		await new Promise((r) => setTimeout(r, 500));
		logger.logBroadcast("worker-1", "hello");
		logger.logBroadcast("worker-2", "world");

		// Read from SSE stream with timeout
		const readPromise = (async () => {
			let buffer = "";
			while (received.length < 2) {
				const { done, value } = await reader!.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (line.startsWith("data: ")) {
						try {
							received.push(JSON.parse(line.slice(6)) as ActivityEntry);
						} catch {
							// ignore parse errors
						}
					}
				}
			}
		})();

		await Promise.race([readPromise, new Promise((r) => setTimeout(r, 5000))]);
		reader?.cancel();

		expect(received.length).toBeGreaterThanOrEqual(2);
		expect(received[0].body).toBe("hello");
		expect(received[1].body).toBe("world");
	});

	it("returns history entries from session.jsonl", async () => {
		// Write some test entries via SwarmSessionManager-backed logger
		const sm = await SwarmSessionManager.create(stateTracker.swarmDir);
		const logger = new ActivityLogger(stateTracker.swarmDir, "test");
		logger.setSessionManager(sm);
		logger.logBroadcast("worker-1", "test message");
		await sm.flush();

		const res = await fetch(`http://127.0.0.1:${port}/api/history`);
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.entries.length).toBeGreaterThanOrEqual(1);

		await sm.close();
	});

	it("returns available models", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/models`);
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.models.length).toBeGreaterThan(0);
		expect(data.models[0]).toHaveProperty("id");
		expect(data.models[0]).toHaveProperty("name");
	});

	it("stops cleanly", () => {
		server.stop();
		expect(server.isRunning).toBe(false);
	});
});
