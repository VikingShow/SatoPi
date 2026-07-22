/**
 * MonitorServer integration tests.
 *
 * Tests the HTTP server, SSE streaming, and REST API endpoints.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { EventEmitter } from "node:events";
import { StateTracker } from "../state";
import { MonitorServer } from "../monitor/server";
import { ActivityLogger } from "../activity-logger";
import type { ActivityEntry } from "../activity-logger";
import { SwarmSessionManager } from "../swarm-session-manager";
import { SessionRegistry, type SharedServices, type SessionFactory } from "../session-registry";

/** Minimal stub that satisfies the SharedServices interface for tests. */
function createSharedServices(tmpDir: string): SharedServices {
	const yamlPath = path.join(tmpDir, "loop.yaml");
	return {
		workspace: tmpDir,
		yamlPath,
		modelRegistry: { getAvailable: () => [{ id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek" }], hasConfiguredAuth: () => false } as unknown as SharedServices["modelRegistry"],
		settings: { get: () => undefined, isConfigured: () => false, override: () => {}, overrideModelRoles: () => {} } as unknown as SharedServices["settings"],
		experienceStore: { init: async () => {}, close: () => {}, search: () => [], getAggregateStats: () => ({}), getRecentLessons: () => [] } as unknown as SharedServices["experienceStore"],
		roleAssetManager: { init: async () => {}, seedIfEmpty: async () => 0, list: async () => [], get: async () => null, create: async () => ({}), update: async () => ({}), approve: async () => ({}), deprecate: async () => ({}), delete: async () => true, search: async () => [] } as unknown as SharedServices["roleAssetManager"],
	};
}

describe("MonitorServer", () => {
	let tmpDir: string;
	let stateTracker: StateTracker;
	let server: MonitorServer;
	let port: number;
	let registry: SessionRegistry;
	const swarmName = "test-swarm";

	beforeEach(async () => {
		tmpDir = path.join(os.tmpdir(), `monitor-test-${Date.now()}`);
		await fs.mkdir(tmpDir, { recursive: true });
		stateTracker = new StateTracker(tmpDir, swarmName);
		await stateTracker.init(["worker-1", "worker-2"], 5, "loop");

		const yamlPath = path.join(tmpDir, "loop.yaml");
		await fs.writeFile(yamlPath, "name: test-swarm\nmode: loop\n");

		const shared = createSharedServices(tmpDir);
		const swarmDir = path.join(tmpDir, `.swarm_${swarmName}`);

		const factory: SessionFactory = async (_shared, _name, _swarmDir) => {
			const activityLogger = new ActivityLogger(_swarmDir, _name);
			return {
				name: _name,
				swarmDir: _swarmDir,
				stateTracker,
				activityLogger,
				runManager: {
					isRunning: false,
					start: async () => ({ success: true }),
					stop: async () => ({ success: true }),
					pause: async () => ({ success: true }),
					resume: async () => ({ success: true }),
					updatePlanAndContinue: async () => ({ success: true }),
				},
				beforeLoopManager: {
					isBusy: false,
					start: async () => ({ success: true }),
					sendMessage: async () => ({ success: true }),
					runDebate: async () => ({ success: true }),
					confirm: async () => ({ success: true }),
					cancel: async () => ({ success: true }),
					getState: () => ({ phase: "idle", task: "", conversationLength: 0, planReady: false, busy: false }),
					getHistory: () => [],
				},
				steeringSink: { steer: () => {} },
			};
		};

		registry = new SessionRegistry(shared, factory);
		await registry.createSession(swarmName);

		server = new MonitorServer(registry);
		port = server.start(20000 + Math.floor(Math.random() * 1000));
	});

	afterEach(() => {
		server?.stop();
	});

	it("starts and listens on the specified port", () => {
		expect(server.isRunning).toBe(true);
		expect(port).toBeGreaterThanOrEqual(17878);
	});

	it("responds to GET /api/session/:name/state with SwarmState", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/session/${swarmName}/state`);
		expect(res.status).toBe(200);
		const data = await res.json() as Record<string, unknown>;
		expect(data.name).toBe(swarmName);
		expect(data.mode).toBe("loop");
		expect(data.status).toBe("running");
		expect((data.agents as Record<string, unknown>)["worker-1"]).toBeDefined();
	});

	it("responds to GET /api/session/:name/config with YAML content", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/session/${swarmName}/config`);
		expect(res.status).toBe(200);
		const data = await res.json() as Record<string, unknown>;
		expect(data.yaml).toContain("name: test-swarm");
		expect(data.yaml).toContain("mode: loop");
	});

	it("handles PUT /api/session/:name/config to update YAML", async () => {
		const newYaml = "name: updated-swarm\nmode: loop\n";
		const res = await fetch(`http://127.0.0.1:${port}/api/session/${swarmName}/config`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ yaml: newYaml }),
		});
		expect(res.status).toBe(200);
		const data = await res.json() as Record<string, unknown>;
		expect(data.success).toBe(true);

		// Verify file was written
		const content = await fs.readFile(path.join(tmpDir, "loop.yaml"), "utf-8");
		expect(content).toBe(newYaml);
	});

	it("streams SSE events when ActivityLogger broadcasts", async () => {
		const session = registry.getSession(swarmName)!;
		session.activityLogger.setBroadcaster(server);

		// SSE endpoint routes events per-session via the `?session=` query
		// parameter. Without it the subscriber joins channel `undefined` and
		// never receives broadcasts keyed to a named session.
		const res = await fetch(`http://127.0.0.1:${port}/events?session=${swarmName}`);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");

		const reader = res.body?.getReader();
		expect(reader).toBeDefined();

		const received: ActivityEntry[] = [];
		const decoder = new TextDecoder();

		// Wait for SSE connection handshake, then emit events.
		// The server sends ": connected\n\n" immediately on subscribe;
		// we delay to let the ReadableStream.start() complete.
		await new Promise((r) => setTimeout(r, 200));
		session.activityLogger.logBroadcast("worker-1", "hello");
		session.activityLogger.logBroadcast("worker-2", "world");

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
		const swarmDir = path.join(tmpDir, `.swarm_${swarmName}`);
		// Write some test entries via SwarmSessionManager-backed logger
		const sm = await SwarmSessionManager.create(swarmDir);
		const logger = new ActivityLogger(swarmDir, "test");
		logger.setSessionManager(sm);
		logger.logBroadcast("worker-1", "test message");
		await sm.flush();

		const res = await fetch(`http://127.0.0.1:${port}/api/session/${swarmName}/history`);
		expect(res.status).toBe(200);
		const data = await res.json() as Record<string, unknown>;
		const entries = data.entries as unknown[];
		expect(entries.length).toBeGreaterThanOrEqual(1);

		await sm.close();
	});

	it("returns available models", async () => {
		const res = await fetch(`http://127.0.0.1:${port}/api/models`);
		expect(res.status).toBe(200);
		const data = await res.json() as Record<string, unknown>;
		const models = data.models as unknown[];
		expect(models.length).toBeGreaterThan(0);
		expect(models[0]).toHaveProperty("id");
		expect(models[0]).toHaveProperty("name");
	});

	it("stops cleanly", () => {
		server.stop();
		expect(server.isRunning).toBe(false);
	});
});
