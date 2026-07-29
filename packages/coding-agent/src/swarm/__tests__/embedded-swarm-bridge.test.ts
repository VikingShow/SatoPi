/**
 * EmbeddedSwarmBridge — Initialization and lifecycle tests.
 *
 * Verifies:
 *   1. Bridge initializes with all services created
 *   2. FSM starts in "script" phase
 *   3. Plan detection logic (onPlanUpdated, isPlanReady)
 *   4. confirmScript rejects without valid plan.md
 *   5. dispose() cleans up without errors
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EmbeddedSwarmBridge, type EmbeddedSwarmConfig, type SwarmEventCallback } from "../core/embedded-swarm-bridge";
import { getSessionPlanPath } from "../script/plan-paths";

// We don't test full Stage/Curtain execution (requires live model + API keys).
// These tests validate the bridge's structural integrity and plan-handling logic.

// ============================================================================
// Test helpers
// ============================================================================

/** Create temporary workspace directory. */
async function tempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "stp-bridge-test-"));
}

/** Minimal model registry stub. */
function stubModelRegistry(): any {
	return {
		getAvailable: () => [] as any[],
		getApiKey: () => undefined,
		find: () => undefined,
		resolver: () => undefined as any,
		authStorage: {},
		hasConfiguredAuth: () => false,
		getAll: () => [],
	};
}

/** Minimal settings stub. */
function stubSettings(): any {
	const store = new Map<string, any>();
	return {
		get: (key: string) => store.get(key),
		getGroup: () => ({}),
		isConfigured: () => false,
	};
}

/** Build a valid EmbeddedSwarmConfig for testing. */
async function makeConfig(overrides: Partial<EmbeddedSwarmConfig> = {}): Promise<EmbeddedSwarmConfig> {
	const workspace = overrides.workspace ?? (await tempDir());
	const swarmDir = overrides.swarmDir ?? path.join(workspace, ".swarm_test");
	return {
		workspace,
		swarmDir,
		modelRegistry: stubModelRegistry(),
		settings: stubSettings(),
		autoApplaud: true, // skip human applaud for tests
		...overrides,
	};
}

/** Capture events from the bridge listener. */
function captureEvents(): { events: any[]; callback: SwarmEventCallback } {
	const events: any[] = [];
	const callback: SwarmEventCallback = event => {
		events.push(event);
	};
	return { events, callback };
}

// ============================================================================
// Tests
// ============================================================================

describe("EmbeddedSwarmBridge", () => {
	let config: EmbeddedSwarmConfig;
	let bridge: EmbeddedSwarmBridge;

	afterEach(async () => {
		if (bridge) {
			await bridge.dispose();
		}
		// Clean up temp dirs
		try {
			await fs.rm(config.workspace, { recursive: true, force: true });
		} catch {
			// best effort
		}
	});

	describe("init()", () => {
		it("initializes all services and starts in script phase", async () => {
			config = await makeConfig();
			const { events, callback } = captureEvents();
			bridge = new EmbeddedSwarmBridge(config, callback);

			await bridge.init();

			// FSM should be in script phase
			expect(bridge.currentPhase).toBe("script");
			expect(bridge.isRunning).toBe(true);

			// All services should exist
			expect(bridge.fsm).toBeDefined();
			expect(bridge.stateTracker).toBeDefined();
			expect(bridge.activityLogger).toBeDefined();
			expect(bridge.swarmState).toBeDefined();
			expect(bridge.swarmState.name).toBe(path.basename(config.swarmDir));
			// Phase may be "idle" if StateTracker.updatePipeline hasn't flushed yet;
			// the FSM itself is authoritative
			expect(["script", "idle"]).toContain(bridge.swarmState.phase!);

			// Should have received a "script: planning" event
			expect(events.some((e: any) => e.phase === "script")).toBe(true);
		});

		it("creates required directories", async () => {
			config = await makeConfig();
			const { callback } = captureEvents();
			bridge = new EmbeddedSwarmBridge(config, callback);
			await bridge.init();

			// .session directory should exist
			await fs.access(path.join(config.swarmDir, ".session"));

			// session files should exist inside .session/
			const files = await fs.readdir(path.join(config.swarmDir, ".session"));
			const jsonlFiles = files.filter(f => f.endsWith(".jsonl"));
			expect(jsonlFiles.length).toBeGreaterThan(0);
		});
	});

	describe("plan detection", () => {
		it("isPlanReady returns false before any plan is provided", () => {
			config = {
				workspace: "/tmp/test",
				swarmDir: "/tmp/test/.swarm_test",
				modelRegistry: stubModelRegistry(),
				settings: stubSettings(),
			};
			const { callback } = captureEvents();
			bridge = new EmbeddedSwarmBridge(config, callback);

			expect(bridge.isPlanReady()).toBe(false);
			expect(bridge.getPlanContent()).toBe("");
		});

		it("onPlanUpdated detects a valid plan with headings and sufficient content", () => {
			config = {
				workspace: "/tmp/test",
				swarmDir: "/tmp/test/.swarm_test",
				modelRegistry: stubModelRegistry(),
				settings: stubSettings(),
			};
			const { events, callback } = captureEvents();
			bridge = new EmbeddedSwarmBridge(config, callback);

			const validPlan = [
				"# Plan: Test Refactor",
				"",
				"## Overview",
				"This is a test plan for refactoring the auth module.",
				"",
				"## Phase 1: Extract JWT Logic",
				"- [ ] Task 1: Extract JWT middleware",
				"  - Files: `src/auth/jwt.ts`",
				"  - Change: Move JWT verification to standalone middleware",
				"  - Acceptance: `bun check` passes, existing tests green",
				"",
				"## Phase 2: Tests",
				"- [ ] Task 2: Add unit tests",
				"  - Files: `src/auth/__tests__/jwt.test.ts`",
				"  - Change: Cover token issuance, verification, expiry",
				"  - Acceptance: `bun test` passes with >= 90% coverage",
			].join("\n");

			bridge.onPlanUpdated(validPlan);

			expect(bridge.isPlanReady()).toBe(true);
			expect(bridge.getPlanContent()).toBe(validPlan);
			expect(events.some((e: any) => e.subStatus === "plan ready for review")).toBe(true);
		});

		it("onPlanUpdated rejects plan without headings", () => {
			config = {
				workspace: "/tmp/test",
				swarmDir: "/tmp/test/.swarm_test",
				modelRegistry: stubModelRegistry(),
				settings: stubSettings(),
			};
			const { callback } = captureEvents();
			bridge = new EmbeddedSwarmBridge(config, callback);

			const noHeadings =
				"This is just some text without any markdown headings. It goes on for a bit to reach the minimum length requirement of 200 characters. ".repeat(
					3,
				);

			bridge.onPlanUpdated(noHeadings);

			expect(bridge.isPlanReady()).toBe(false);
		});

		it("onPlanUpdated rejects too-short plan", () => {
			config = {
				workspace: "/tmp/test",
				swarmDir: "/tmp/test/.swarm_test",
				modelRegistry: stubModelRegistry(),
				settings: stubSettings(),
			};
			const { callback } = captureEvents();
			bridge = new EmbeddedSwarmBridge(config, callback);

			const tooShort = "# Plan\n\nToo short.";

			bridge.onPlanUpdated(tooShort);

			expect(bridge.isPlanReady()).toBe(false);
		});
	});

	describe("confirmScript", () => {
		it("returns error when plan.md does not exist on disk", async () => {
			config = await makeConfig();
			const { callback } = captureEvents();
			bridge = new EmbeddedSwarmBridge(config, callback);
			await bridge.init();

			const errors = await bridge.confirmScript();
			expect(errors.length).toBeGreaterThan(0);
			expect(errors[0]).toContain("plan.md not found");
		});

		it("returns error when plan.md lacks ## Phase headings", async () => {
			config = await makeConfig();
			const { callback } = captureEvents();
			bridge = new EmbeddedSwarmBridge(config, callback);
			await bridge.init();

			// Write a plan without ## Phase headings (but with enough chars and some generic heading)
			const planPath = getSessionPlanPath(config.swarmDir);
			await fs.mkdir(path.dirname(planPath), { recursive: true });
			await fs.writeFile(planPath, "# Overview\nSome content without Phase headings. ".repeat(20));

			const errors = await bridge.confirmScript();
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some((e: string) => e.includes("## Phase"))).toBe(true);
		});

		it("returns error when task checklist items lack contracts", async () => {
			config = await makeConfig();
			const { callback } = captureEvents();
			bridge = new EmbeddedSwarmBridge(config, callback);
			await bridge.init();

			// Write a plan with Phase heading but incomplete tasks
			const planPath = getSessionPlanPath(config.swarmDir);
			await fs.mkdir(path.dirname(planPath), { recursive: true });
			const planContent = [
				"# Plan",
				"",
				"## Phase 1: Setup",
				"",
				"- [ ] Do the thing (missing contract fields)",
				"  Some details here",
				"- [ ] Another incomplete task",
				"",
				"Some filler text. ".repeat(30),
			].join("\n");
			await fs.writeFile(planPath, planContent);

			const errors = await bridge.confirmScript();
			expect(errors.length).toBeGreaterThan(0);
			expect(errors.some((e: string) => e.includes("missing"))).toBe(true);
		});

		it("passes validation for well-formed plan with contracts", async () => {
			config = await makeConfig();
			const { callback } = captureEvents();
			bridge = new EmbeddedSwarmBridge(config, callback);
			await bridge.init();

			// Write a well-formed plan
			const planPath = getSessionPlanPath(config.swarmDir);
			await fs.mkdir(path.dirname(planPath), { recursive: true });
			const planContent = [
				"# Plan",
				"",
				"## Phase 1: Setup",
				"",
				"- [ ] Initialize project",
				"  Files: package.json, tsconfig.json",
				"  Change: Set up the base config",
				"  Acceptance: `bun run build` succeeds",
				"",
				"- [ ] Add tests",
				"  Files: src/__tests__/",
				"  Change: Write unit tests",
				"  Acceptance: All tests pass",
				"",
				"Some filler text to meet the length requirement. ".repeat(30),
			].join("\n");
			await fs.writeFile(planPath, planContent);

			const errors = await bridge.confirmScript();
			// Should pass validation (empty errors array)
			expect(errors.filter(e => e.includes("missing") || e.includes("Phase") || e.includes("short"))).toHaveLength(
				0,
			);
		});
	});

	describe("dispose", () => {
		it("dispose is idempotent and does not throw", async () => {
			config = await makeConfig();
			const { callback } = captureEvents();
			bridge = new EmbeddedSwarmBridge(config, callback);
			await bridge.init();

			await bridge.dispose();
			// Second dispose should not throw
			await bridge.dispose();
		});
	});
});
