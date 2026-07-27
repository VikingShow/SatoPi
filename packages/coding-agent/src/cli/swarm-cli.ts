/**
 * Swarm CLI command handlers.
 *
 * Handles `stp swarm run|plan|resume` subcommands for managing swarm runs.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { ProfileRegistry } from "../agent/agent-profile";
import { RoleAssetManager } from "../agent/role-asset";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { MarkEnvironment } from "../coordination/mark-environment";
import { IrcBus } from "../irc/bus";
import { NoopOffloadManager } from "../offload/manager";
import { discoverAuthStorage } from "../sdk";
import type { SwarmDefinition } from "../swarm/core";
import { assembleAgentRuntime } from "../swarm/core/assembler";
import type { RunManager, SteeringSink } from "../swarm/core/services";
import { StateTracker } from "../swarm/core/state";
import { SwarmRunner } from "../swarm/core/swarm-runner";
import { GraphRunner } from "../swarm/graph/graph-runner";
import { GraphRunnerAsRunManager } from "../swarm/core/graph-runner-as-run-manager";
import { ExperienceStore } from "../swarm/curtain/experience";
import { HookPipeline } from "../swarm/hook-system/hook-pipeline";
import { registerBuiltinHooks } from "../swarm/hook-system/register-builtins";
import { ActivityLogger } from "../swarm/infra/activity-logger";
import { createSwarmHindsightClient } from "../swarm/infra/hindsight-adapter";
import { createSwarmMnemopiClient } from "../swarm/infra/create-mnemopi-client";
import { SwarmMnemopiAdapter } from "../swarm/infra/mnemopi-adapter";
import { ScriptManager } from "../swarm/script/script-manager";
import { SessionRegistry } from "../swarm/session";
import type { SessionFactory, SharedServices } from "../swarm/session/session-registry";

export type SwarmAction = "run" | "plan" | "resume";

export interface SwarmCommandArgs {
	action: SwarmAction;
	/** YAML path for run/plan, session name for resume. */
	target: string;
	flags: Record<string, unknown>;
	engine?: "graph" | "legacy";
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
// Shared service assembly (used by run + plan)
// ============================================================================

/**
 * Create the SharedServices bag and SessionFactory for a swarm run.
 * Returns both so callers can customize the session before starting.
 */
async function createSwarmServices(
	cwd: string,
	yamlPath: string,
	_def: SwarmDefinition,
	engine: "graph" | "legacy" = "legacy",
): Promise<{ shared: SharedServices; factory: SessionFactory }> {
	const authStorage = await discoverAuthStorage();
	const settings = await Settings.init({ cwd });
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh("online-if-uncached");

	const experienceStore = new ExperienceStore(cwd);
	await experienceStore.init();

	// Remote Hindsight handle for cross-session recall/retain. Null when the
	// project has no Hindsight config — sources/sinks then degrade to no-ops.
	const hindsightClient = createSwarmHindsightClient(settings, cwd);

	// Mnemopi semantic memory handle — creates a standalone Mnemopi instance
	// for the swarm session. Null when Mnemopi is unavailable or unconfigured.
	const mnemopiClient = await createSwarmMnemopiClient(settings, cwd);

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
		markEnvironment,
		hindsightClient,
		mnemopiClient,
	};

	const factory: SessionFactory = async (s, name, swarmDir) => {
		const stateTracker = new StateTracker(cwd, name);
		const activityLogger = new ActivityLogger(swarmDir, name);

		// HookPipeline with NoopOffloadManager — SessionRegistry upgrades
		// to a real OffloadManager once SessionStorage is available.
		const hookPipeline = new HookPipeline();
		registerBuiltinHooks(hookPipeline, {
			offloadManager: new NoopOffloadManager(),
			profileRegistry: s.profileRegistry,
			experienceStore: s.experienceStore,
			mnemopiAdapter: s.mnemopiClient ? new SwarmMnemopiAdapter(s.mnemopiClient, {
				enabled: true,
				topK: 5,
				deduplicate: true,
				autoStoreThreshold: 5,
			}) : undefined,
		});

		// Assemble AgentRuntime with full DI (no global singletons).
		// IrcBus.global() is the one exception — oh-my-pi owns it.
		const ircBus = IrcBus.global();
		const runtime = assembleAgentRuntime({
			modelRegistry: s.modelRegistry,
			settings: s.settings,
			activityLogger,
			roleAssetManager: s.roleAssetManager,
			hookPipeline,
			ircBus,
			experienceStore: s.experienceStore,
			hindsightClient: s.hindsightClient,
			mnemopiClient: s.mnemopiClient,
		});
		let runManager: RunManager;
		if (engine === "graph") {
			// GraphRunner implements ISwarmOrchestrator; wrap in adapter for RunManager.
			const graphRunner = new GraphRunner({
				workspace: s.workspace,
				graphPath: s.yamlPath,
				modelRegistry: s.modelRegistry,
				settings: s.settings,
				profileRegistry: s.profileRegistry,
			});
			await graphRunner.init();
			runManager = new GraphRunnerAsRunManager(graphRunner);
		} else {
			// Legacy SwarmRunner with AgentRuntime — StageController uses
			// runtime.spawn() instead of the legacy streamAgentOutput path.
			runManager = new SwarmRunner({
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
				hookPipeline,
				runtime,
				hindsightClient: s.hindsightClient,
			});
		}

		// Real ScriptManager with AgentRuntime wired in.
		const scriptManager = new ScriptManager({
			modelRegistry: s.modelRegistry,
			settings: s.settings,
			workspace: s.workspace,
			swarmDir,
			yamlPath: s.yamlPath,
			stateTracker,
			activityLogger,
			experienceStore: s.experienceStore,
			runManager,
			profileRegistry: s.profileRegistry,
			roleAssetManager: s.roleAssetManager,
			commBus: runtime.commBus,
		});
		scriptManager.setRuntime(runtime);

		// Real SteeringSink — routes human steering via CommBus → AgentRuntime.
		const steeringSink: SteeringSink = {
			steer(text: string): void {
				void runtime.sendHumanMessage("planner", text);
			},
		};

		return { name, swarmDir, stateTracker, activityLogger, runManager, scriptManager, steeringSink, hookPipeline };
	};

	return { shared, factory };
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
	const authStorage = await discoverAuthStorage();
	try {
		const engine = (cmd.engine ?? "legacy") as "graph" | "legacy";
		const { shared, factory } = await createSwarmServices(cwd, yamlPath, def, engine);

		const registry = new SessionRegistry(shared, factory, 1);
		const session = await registry.createSession(swarmName);

		process.stderr.write(`Starting swarm "${swarmName}"…\n`);

		const result = await session.runManager.start();
		if (!result.success) {
			process.stderr.write(`Swarm failed: ${result.error ?? "unknown error"}\n`);
			process.exitCode = 1;
			return;
		}

		if (engine === "graph") {
			// GraphRunnerAsRunManager handles completion internally.
			process.stderr.write(`Graph "${swarmName}" started.\n`);
		} else {
			process.stderr.write(`Swarm "${swarmName}" started, waiting for completion…\n`);
			await (session.runManager as SwarmRunner).waitForCompletion();
			const curtainResult = (session.runManager as SwarmRunner).getLastCurtainResult();
			if (curtainResult) {
				process.stderr.write(`Swarm "${swarmName}" completed: ${curtainResult.status}\n`);
			} else {
				process.stderr.write(`Swarm "${swarmName}" finished.\n`);
			}
		}
	} finally {
		authStorage.close();
	}
}

// ============================================================================
// plan — interactive planning REPL
// ============================================================================

async function runSwarmPlan(cmd: SwarmCommandArgs): Promise<void> {
	const yamlPath = path.resolve(cmd.target);
	const cwd = getProjectDir();

	let def: SwarmDefinition;
	try {
		def = await parseSwarmYamlFile(yamlPath);
	} catch (err) {
		process.stderr.write(`Failed to parse ${yamlPath}: ${String(err)}\n`);
		process.exitCode = 1;
		return;
	}

	const swarmName = def.name;
	const authStorage = await discoverAuthStorage();
	try {
		const { shared, factory } = await createSwarmServices(cwd, yamlPath, def);
		const registry = new SessionRegistry(shared, factory, 1);
		const session = await registry.createSession(swarmName);

		const sm = session.scriptManager as ScriptManager;

		process.stderr.write(`\n`);
		process.stderr.write(`╔══════════════════════════════════════════════╗\n`);
		process.stderr.write(`║  SatoPi Swarm Plan — Interactive Planner      ║\n`);
		process.stderr.write(`║  Swarm: ${swarmName.padEnd(36)}║\n`);
		process.stderr.write(`╚══════════════════════════════════════════════╝\n`);
		process.stderr.write(`\nCommands: /send <text>, /debate, /confirm [N], /status, /cancel, /quit\n`);
		process.stderr.write(`Type a message and press Enter to chat with the planner.\n\n`);

		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stderr,
			prompt: "you> ",
		});

		rl.prompt();

		rl.on("line", async (line: string) => {
			const input = line.trim();
			if (!input) {
				rl.prompt();
				return;
			}

			// Slash commands
			if (input.startsWith("/")) {
				const [cmd, ...rest] = input.slice(1).split(/\s+/);
				switch (cmd) {
					case "send": {
						const text = rest.join(" ");
						if (!text) {
							process.stderr.write("Usage: /send <text>\n");
							break;
						}
						const r = await sm.sendMessage(text);
						if (!r.success) process.stderr.write(`Error: ${r.error}\n`);
						break;
					}
					case "debate": {
						const r = await sm.runDebate();
						if (!r.success) process.stderr.write(`Error: ${r.error}\n`);
						break;
					}
					case "confirm": {
						const agentCount = rest[0] ? parseInt(rest[0], 10) : undefined;
						const r = await sm.confirm(agentCount);
						if (r.success) {
							process.stderr.write("Plan confirmed. Starting stage execution…\n");
							rl.close();
						} else {
							process.stderr.write(`Error: ${r.error}\n`);
						}
						break;
					}
					case "status": {
						const state = sm.getState();
						process.stderr.write(
							`Phase: ${state.phase} | Busy: ${state.busy} | ` +
								`Plan ready: ${state.planReady} | ` +
								`Conversation: ${state.conversationLength} turns\n`,
						);
						break;
					}
					case "cancel": {
						await sm.cancel();
						process.stderr.write("Script phase cancelled.\n");
						break;
					}
					case "quit":
					case "exit": {
						await sm.cancel();
						rl.close();
						return;
					}
					default:
						process.stderr.write(`Unknown command: /${cmd}\n`);
				}
				rl.prompt();
				return;
			}

			// If this is the first message, start the planner with it.
			const state = sm.getState();
			if (state.phase === "idle" || state.phase === "curtain") {
				const r = await sm.start(input);
				if (!r.success) process.stderr.write(`Error: ${r.error}\n`);
			} else {
				// Subsequent messages go through sendMessage
				const r = await sm.sendMessage(input);
				if (!r.success) process.stderr.write(`Error: ${r.error}\n`);
			}
			rl.prompt();
		});

		rl.on("close", () => {
			process.stderr.write("\nExiting plan mode.\n");
		});

		// Keep the process alive until the user quits
		await new Promise<void>(resolve => {
			rl.on("close", () => resolve());
		});
	} finally {
		authStorage.close();
	}
}

// ============================================================================
// resume (placeholder)
// ============================================================================

async function runSwarmResume(_cmd: SwarmCommandArgs): Promise<void> {
	process.stderr.write("resume not yet implemented\n");
	process.exitCode = 1;
}
