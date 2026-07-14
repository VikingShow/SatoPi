/**
 * Quick integration smoke test for Loop Engineering.
 * Verifies: YAML parse → validation → DAG → LoopController instantiation → state tracking
 * No LLM calls — tests the orchestration machinery only.
 */

import * as path from "node:path";
import { buildDependencyGraph, buildExecutionWaves, detectCycles } from "../dag";
import { LoopController } from "../loop-controller";
import { parseSwarmYaml, validateSwarmDefinition } from "../schema";
import { StateTracker } from "../state";
import { VisibilityRenderer } from "../visibility-renderer";
import * as fs from "node:fs/promises";

// Paths relative to the SatoPi project root
const PROJECT_ROOT = path.resolve(import.meta.dirname!, "../../../../..");
const YAML_PATH = path.resolve(PROJECT_ROOT, ".omp/loop-test.yaml");
const WORKSPACE = path.resolve(PROJECT_ROOT, "test-workspace");

async function main() {
	console.log("=== Loop Engineering Smoke Test ===\n");

	// 1. Parse YAML
	console.log("[1/6] Parsing loop-test.yaml...");
	const content = await Bun.file(YAML_PATH).text();
	const def = parseSwarmYaml(content);
	console.log(`  ✓  name: ${def.name}`);
	console.log(`  ✓  mode: ${def.mode}`);
	console.log(`  ✓  agents: ${def.agents.size}`);
	console.log(`  ✓  loopConfig: maxIterations=${def.loopConfig?.maxIterations}, reviewGate=${def.loopConfig?.reviewGate}`);
	console.log(`  ✓  core reviewers: ${def.loopConfig?.reviewers.core.join(", ")}`);
	console.log(`  ✓  optional pool: ${def.loopConfig?.reviewers.pool.length} reviewers\n`);

	// 2. Validate
	console.log("[2/6] Validating definition...");
	const errors = validateSwarmDefinition(def);
	if (errors.length > 0) {
		console.log(`  ✗  ${errors.length} errors:`);
		for (const e of errors) console.log(`     - ${e}`);
		process.exit(1);
	}
	console.log("  ✓  No validation errors\n");

	// 3. Build DAG
	console.log("[3/6] Building DAG and execution waves...");
	const deps = buildDependencyGraph(def);
	const cycles = detectCycles(deps);
	if (cycles) {
		console.log(`  ✗  Cycle detected: ${cycles.join(", ")}`);
		process.exit(1);
	}
	const waves = buildExecutionWaves(deps);
	console.log(`  ✓  DAG: ${waves.length} wave(s)`);
	for (let i = 0; i < waves.length; i++) {
		console.log(`     Wave ${i + 1}: [${waves[i].join(", ")}]`);
	}
	console.log();

	// 4. State tracker
	console.log("[4/6] Initializing state tracker...");
	await fs.mkdir(WORKSPACE, { recursive: true });
	const tracker = new StateTracker(WORKSPACE, def.name);
	await tracker.init([...def.agents.keys()], def.loopConfig!.maxIterations, def.mode);
	console.log(`  ✓  State dir: .swarm_${def.name}/`);
	console.log(`  ✓  Status: ${tracker.state.status}\n`);

	// 5. LoopController instantiation
	console.log("[5/6] Instantiating LoopController...");
	const controller = new LoopController(def, waves, tracker, {
		loopConfig: def.loopConfig!,
		workspace: WORKSPACE,
	});
	console.log("  ✓  LoopController created");
	console.log(`  ✓  Max iterations: ${def.loopConfig!.maxIterations}`);
	console.log();

	// 6. VisibilityRenderer
	console.log("[6/6] VisibilityRenderer...");
	const renderer = new VisibilityRenderer({
		enabled: true,
		showThinking: true,
		showIrc: true,
		showRoundtable: true,
		showReviewPanel: true,
		showProgressBar: true,
	});
	renderer.renderProgress(0, def.loopConfig!.maxIterations);

	// Roundtable phases (only methods that use fields in current RoundtableResult)
	renderer.renderRoundtablePhase("propose");
	renderer.renderProposals({ proposals: [{ agentId: "lancelot", body: "I will create README.md" }], verdict: "approved", approvalRate: 1 } as any);
	renderer.renderRoundtablePhase("debate");
	renderer.renderRoundtablePhase("vote");

	// Review council
	renderer.renderReviewCouncil(["clotho", "lachesis", "atropos"]);
	renderer.renderReviewVerdict({
		passed: true, atroposApproved: true, approvalCount: 3, totalCount: 3, findings: [],
	});

	// Agent thinking & IRC
	renderer.renderThinking("merlin", "Analyzing task... score=2 → 2 knights");
	renderer.renderIrc("lancelot", "bedivere", "I'll handle README, you review.");
	renderer.renderIrc("bedivere", "lancelot", "Agreed.");

	renderer.renderProgress(1, def.loopConfig!.maxIterations);
	console.log("  ✓  All render calls executed\n");

	// Summary
	console.log("=== ALL CHECKS PASSED ===");
	console.log(`  Schema parse:     ✓`);
	console.log(`  Validation:       ✓`);
	console.log(`  DAG construction: ✓ (${waves.length} waves)`);
	console.log(`  State tracker:    ✓`);
	console.log(`  LoopController:   ✓ ready`);
	console.log(`  Visibility:       ✓`);
	console.log(`\nNext step: run with real LLM → bun packages/swarm-extension/src/cli.ts .omp/loop-test.yaml`);
}

main().catch((err) => {
	console.error(`FATAL: ${err.message}`);
	process.exit(1);
});
