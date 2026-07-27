/**
 * Smoke test: GraphRunner init with real configuration.
 * Verifies the full init() path works with actual Settings and ModelRegistry.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "../../config/settings";
import { ModelRegistry } from "../../config/model-registry";
import { GraphRunner } from "../graph/graph-runner";

const BUILTIN_GRAPH = path.resolve(import.meta.dir, "../graph/builtin/theatre.graph.yaml");

describe("GraphRunner integration smoke", () => {
	it("init() completes with real services", async () => {
		const cwd = path.resolve(import.meta.dir, "..");
		const settings = await Settings.init({ cwd });
		const modelRegistry = new ModelRegistry(settings);
		await modelRegistry.init();

		const runner = new GraphRunner({
			workspace: cwd,
			graphPath: BUILTIN_GRAPH,
			modelRegistry,
			settings,
		});

		await runner.init();

		expect(runner.graph.name).toBe("theatre");
		expect(Object.keys(runner.graph.nodes).length).toBe(3);
		expect(runner.currentPhase).toBe("stage");
		expect(runner.isRunning).toBe(true);
		expect(runner.fsm).toBeDefined();
		expect(runner.stateTracker).toBeDefined();
		expect(runner.gateController).toBeDefined();

		await runner.dispose();
		expect(runner.isRunning).toBe(false);
	});
});
