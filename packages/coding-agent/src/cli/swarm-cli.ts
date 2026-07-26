/**
 * Swarm CLI command handlers.
 *
 * Handles `stp swarm run|plan|resume` subcommands for managing swarm runs.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";
import { SessionRegistry } from "../swarm/session";
import type { SharedServices, SessionFactory } from "../swarm/session/session-registry";
import { StateTracker } from "../swarm/core/state";
import { SwarmRunner } from "../swarm/core/swarm-runner";
import type { RunManager, ScriptManager, SteeringSink } from "../swarm/core/services";
import { ActivityLogger } from "../swarm/hooks/activity-logger";
import { ExperienceStore } from "../swarm/curtain/experience";
import { ProfileRegistry } from "../swarm/agent/agent-profile";
import { MarkEnvironment } from "../swarm/coordination/mark-environment";
import { RoleAssetManager } from "../swarm/agent/role-asset";
import type { SwarmDefinition } from "../swarm/core";

export type SwarmAction = "run" | "plan" | "resume";

export interface SwarmCommandArgs {
	action: SwarmAction;
	/** YAML path for run/plan, session name for resume. */
	target: string;
	flags: Record<string, unknown>;
}

// ============================================================================
// Entry point
// ============================================================================

export async function runSwarmCommand(cmd: SwarmCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "run":
			return runSwarmRun(cmd);
		case "plan":
			return runSwarmPlan(cmd);
		case "resume":
			return runSwarmResume(cmd);
	}
}

// ============================================================================
// run
// ============================================================================

async function parseSwarmYamlFile(filePath: string): Promise<SwarmDefinition> {
	const content = await fs.readFile(filePath, "utf-8");
	const raw = Bun.YAML.parse(content) as { swarm?: { name: string } } | null;
	if (!raw?.swarm?.name) {
		throw new Error(`YAML at ${filePath} must have a top-level 'swarm' key with a 'name' field`);
	}

	// Reuse the schema module's parser for the full definition
	const { parseSwarmYaml } = await import("../swarm/core/schema");
	return parseSwarmYaml(content);
}

async function runSwarmRun(cmd: SwarmCommandArgs): Promise<void> {
	const yamlPath = path.resolve(cmd.target);
	const cwd = getProjectDir();

	// Pre-parse YAML to get the swarm name for SessionRegistry.
	let def: SwarmDefinition;
	try {
		def = await parseSwarmYamlFile(yamlPath);
	} catch (err) {
		process.stderr.write(`Failed to parse ${yamlPath}: ${String(err)}\n`);
		process.exitCode = 1;
		return;
	}

	const swarmName = def.name;

	// ── Shared services ─────────────────────────────────────────────────
	const authStorage = await discoverAuthStorage();
	try {
		const settings = await Settings.init({ cwd });
		const modelRegistry = new ModelRegistry(authStorage);
		await modelRegistry.refresh("online-if-uncached");

		const experienceStore = new ExperienceStore(cwd);
		await experienceStore.init();

		const profileRegistry = new ProfileRegistry();
		const markEnvironment = new MarkEnvironment();
		const roleAssetManager = new RoleAssetManager(cwd);
		await roleAssetManager.init();

		const shared: SharedServices = {
			workspace: cwd,
			yamlPath,
			modelRegistry,
			settings,
			experienceStore,
			roleAssetManager,
			profileRegistry,
		};

		// ── Factory: builds per-session services ───────────────────────────
		const factory: SessionFactory = async (s, name, swarmDir) => {
			const stateTracker = new StateTracker(cwd, name);
			const activityLogger = new ActivityLogger(swarmDir, name);

			// SwarmRunner: the RunManager for loop-mode runs.
			const runManager: RunManager = new SwarmRunner({
				modelRegistry: s.modelRegistry,
				settings: s.settings,
				workspace: s.workspace,
				yamlPath: s.yamlPath,
				stateTracker,
				activityLogger,
				experienceStore: s.experienceStore,
				sessionManager: undefined,
				profileRegistry: s.profileRegistry,
				markEnvironment,
				roleAssetManager: s.roleAssetManager,
			});

			// Placeholder ScriptManager.
			const scriptManager: ScriptManager = {
				isBusy: false,
				async start(): Promise<{ success: boolean; error?: string }> {
					return { success: false, error: "Script phase not available in CLI mode" };
				},
				async sendMessage(): Promise<{ success: boolean; error?: string }> {
					return { success: false, error: "Script phase not available in CLI mode" };
				},
				async runDebate(): Promise<{ success: boolean; error?: string }> {
					return { success: false, error: "Script phase not available in CLI mode" };
				},
				async confirm(): Promise<{ success: boolean; error?: string }> {
					return { success: false, error: "Script phase not available in CLI mode" };
				},
				async cancel(): Promise<{ success: boolean; error?: string }> {
					return { success: true };
				},
				getState() {
					return {
						phase: "idle",
						task: "",
						conversationLength: 0,
						planReady: false,
						busy: false,
					};
				},
				getHistory() {
					return [];
				},
			};

			// Placeholder SteeringSink.
			const steeringSink: SteeringSink = {
				steer(_text: string): void {
					// Steering not supported in CLI mode.
				},
			};

			return { name, swarmDir, stateTracker, activityLogger, runManager, scriptManager, steeringSink };
		};

		// ── Create and start ──────────────────────────────────────────────
		const registry = new SessionRegistry(shared, factory, 1);
		const session = await registry.createSession(swarmName);

		process.stderr.write(`Starting swarm "${swarmName}"…\n`);

		const result = await session.runManager.start();
		if (!result.success) {
			process.stderr.write(`Swarm failed: ${result.error ?? "unknown error"}\n`);
			process.exitCode = 1;
			return;
		}

		process.stderr.write(`Swarm "${swarmName}" started successfully.\n`);
	} finally {
		authStorage.close();
	}
}

// ============================================================================
// plan (placeholder)
// ============================================================================

async function runSwarmPlan(cmd: SwarmCommandArgs): Promise<void> {
	process.stderr.write("plan mode not yet implemented\n");
	process.exitCode = 1;
}

// ============================================================================
// resume (placeholder)
// ============================================================================

async function runSwarmResume(cmd: SwarmCommandArgs): Promise<void> {
	process.stderr.write("resume not yet implemented\n");
	process.exitCode = 1;
}
