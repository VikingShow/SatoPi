#!/usr/bin/env bun
/**
 * Direct Stage runner — executes a SatoPi swarm using StageController.
 *
 * Usage: bun cli.ts <path-to-yaml>
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExperienceStore, extractLessons } from "@oh-my-pi/pi-coding-agent/swarm/curtain/index";
import { createStageController } from "@oh-my-pi/pi-coding-agent/swarm/stage/stage-controller";
import { parseSwarmYaml, validateSwarmDefinition } from "@oh-my-pi/pi-coding-agent/swarm/core/schema";
import { StateTracker } from "@oh-my-pi/pi-coding-agent/swarm/core/state";
import { ProfileRegistry } from "@oh-my-pi/pi-coding-agent/swarm/agent/agent-profile";
import { RoleAssetManager } from "@oh-my-pi/pi-coding-agent/swarm/agent/role-asset";
import { renderSwarmProgress } from "@oh-my-pi/pi-coding-agent/swarm/render/render";
import { ActivityLogger } from "@oh-my-pi/pi-coding-agent/swarm/hooks/activity-logger";

const yamlPath = process.argv[2];
if (!yamlPath) {
	console.error("Usage: omp-swarm <path-to-yaml>");
	process.exit(1);
}

const resolvedPath = path.resolve(yamlPath);
console.log(`Reading: ${resolvedPath}`);

const content = await Bun.file(resolvedPath).text();
const def = parseSwarmYaml(content);

console.log(`Swarm: ${def.name}`);
console.log(`Mode: ${def.mode}`);
console.log(`Agents: ${[...def.agents.keys()].join(", ") || "(none defined in YAML)"}`);

// Validate
const errors = validateSwarmDefinition(def);
if (errors.length > 0) {
	console.error("Validation errors:", errors);
	process.exit(1);
}

// Resolve workspace
const workspace = path.isAbsolute(def.workspace)
	? def.workspace
	: path.resolve(path.dirname(resolvedPath), def.workspace);

await fs.mkdir(workspace, { recursive: true });
console.log(`Workspace: ${workspace}`);

// Initialize
const stateTracker = new StateTracker(workspace, def.name);
await stateTracker.init([...def.agents.keys()], def.agents.size || 1, def.mode);

// Auth + settings
const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
const settings = Settings.isolated();

// Identity system
const profileRegistry = await ProfileRegistry.load(workspace);
const roleAssetManager = new RoleAssetManager(workspace);
await roleAssetManager.seedIfEmpty();

// Activity logger (console-only, no SSE)
const activityLogger = new ActivityLogger(stateTracker.swarmDir, def.name);

// Read plan.md from session directory if it exists
let planContent: string | undefined;
try {
	planContent = await Bun.file(path.join(stateTracker.swarmDir, ".omp", "plan.md")).text();
	console.log(`Plan loaded: ${planContent.length} chars`);
} catch {
	console.log("No plan.md found — creating default plan.");
}

// ── Run Stage ──
console.log("\n--- Stage starting ---\n");

if (!def.loopConfig) {
	console.error("Error: Swarm must be in loop mode with a valid config");
	process.exit(1);
}

const stage = createStageController({
	workspace,
	swarmName: def.name,
	planContent: planContent ?? "",
	loopConfig: def.loopConfig,
	stateTracker,
	activityLogger,
	modelRegistry,
	settings,
	profileRegistry,
	roleAssetManager,
});

const result = await stage.run();

// ── Curtain: persist experience ──
try {
	const store = new ExperienceStore(workspace);
	await store.init();
	const extraction = extractLessons(
		{ status: result.status, iterations: 1, reviewVerdicts: [], errors: result.errors },
		result.agents.length,
		0,
	);
	for (const lesson of extraction.lessons) {
		store.saveLesson({
			runId: `stage-${def.name}-${Date.now()}`,
			timestamp: new Date().toISOString(),
			lesson,
			stats: extraction.stats,
		});
	}
	console.log(`\nLessons persisted: ${extraction.lessons.length}`);
} catch (err) {
	console.warn(`Failed to persist experience: ${String(err)}`);
}

console.log("\n--- Stage finished ---\n");
console.log(`Status: ${result.status}`);
console.log(`Tasks: ${result.taskProgress.completed}/${result.taskProgress.total}`);
console.log(`Agents: ${result.agents.map(a => `${a.id}=${a.role}`).join(", ")}`);
if (result.errors.length > 0) {
	console.log(`Errors (${result.errors.length}):`);
	for (const err of result.errors) {
		console.log(`  - ${err}`);
	}
}
console.log(`\nState saved to: ${stateTracker.swarmDir}`);

// Final state dump
const lines = renderSwarmProgress(stateTracker.state);
console.log(lines.join("\n"));
process.exit(0);
