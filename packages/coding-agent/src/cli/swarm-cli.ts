/**
 * Swarm CLI command handlers.
 *
 * Handles `stp swarm run|plan|resume` subcommands for managing swarm runs.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { getProjectDir } from "@satopi/pi-utils";
import { ProfileRegistry } from "../agent/agent-profile";
import { RoleAssetManager } from "../agent/role-asset";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { MarkEnvironment } from "../coordination/mark-environment";
import { ExperienceStore } from "../experience/experience";
import { DebateRoundtable } from "../graph/behaviors/debate-roundtable";
import { GraphRunner } from "../graph/graph-runner";
import { getSessionPlanPath } from "../graph/plan-paths";
import { registerBuiltinHooks } from "../hooks/register-builtins";
import { NoopOffloadManager } from "../offload/manager";
import { discoverAuthStorage } from "../sdk";
import type { SwarmDefinition } from "../swarm/core";
import { GraphRunnerAsRunManager } from "../swarm/core/graph-runner-as-run-manager";
import type { SteeringSink } from "../swarm/core/services";
import { setCurrentSwarmPhase } from "../swarm/core/state";
import { createSwarmInfra } from "../swarm/core/swarm-infra";
import { createSwarmMnemopiClient } from "../swarm/infra/create-mnemopi-client";
import { createSwarmHindsightClient } from "../swarm/infra/hindsight-adapter";
import { SwarmMnemopiAdapter } from "../swarm/infra/mnemopi-adapter";
import { SessionRegistry } from "../swarm/session";
import type { SessionFactory, SharedServices } from "../swarm/session/session-registry";
import { SwarmSessionManager } from "../swarm/session/swarm-session-manager";

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
// Shared service assembly (used by run + plan)
// ============================================================================

/**
 * Create the SharedServices bag and SessionFactory for a swarm run.
 * Returns both so callers can customize the session before starting.
 *
 * With `{ resume: true }` the session's entry reader spans every session
 * file in the swarm dir (oldest first) instead of just the newest — see
 * readAllSessionEntries for why resume needs that.
 */
async function createSwarmServices(
	cwd: string,
	yamlPath: string,
	_def: SwarmDefinition,
	opts?: { resume?: boolean },
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

	const profileRegistry = await ProfileRegistry.initGlobal(cwd);
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
		// Create shared swarm infrastructure (StateTracker, SwarmSessionManager,
		// ActivityLogger, ExperienceStore, RoleAssetManager, HookPipeline, runtime).
		const infra = await createSwarmInfra({
			workspace: s.workspace,
			swarmDir,
			swarmName: name,
			modelRegistry: s.modelRegistry,
			settings: s.settings,
			profileRegistry: s.profileRegistry,
			startPhase: "script",
		});

		// Register custom hooks (MnemopiAdapter)
		registerBuiltinHooks(infra.hookPipeline, {
			offloadManager: new NoopOffloadManager(),
			profileRegistry: s.profileRegistry,
			experienceStore: infra.experienceStore,
			mnemopiAdapter: s.mnemopiClient
				? new SwarmMnemopiAdapter(s.mnemopiClient, {
						enabled: true,
						topK: 5,
						deduplicate: true,
						autoStoreThreshold: 5,
					})
				: undefined,
		});

		// GraphRunner with injected infra
		const graphRunner = new GraphRunner({
			workspace: s.workspace,
			graphPath: s.yamlPath,
			modelRegistry: s.modelRegistry,
			settings: s.settings,
			profileRegistry: s.profileRegistry,
			infra,
			onPhaseChange: phase => setCurrentSwarmPhase(phase),
			debateRoundtableFactory: config => new DebateRoundtable(config),
			readSessionEntries: opts?.resume
				? () => readAllSessionEntries(swarmDir)
				: () => SwarmSessionManager.readRawEntries(swarmDir),
		});
		await graphRunner.init();
		const runManager = new GraphRunnerAsRunManager(graphRunner);

		// Real SteeringSink — routes human steering via IrcBus.
		const steeringSink: SteeringSink = {
			steer(text: string): void {
				void infra.runtime.sendHumanMessage("planner", text);
			},
		};

		return {
			name,
			swarmDir,
			stateTracker: infra.stateTracker,
			activityLogger: infra.activityLogger,
			runManager,
			steeringSink,
			hookPipeline: infra.hookPipeline,
		};
	};

	return { shared, factory };
}

/**
 * Read every session file in a swarm's `.session` dir, oldest file first.
 *
 * Each run rotates to a fresh session file (createSwarmInfra forces a new
 * one), and SwarmSessionManager.readRawEntries only reads the newest file.
 * Checkpoint recovery scans entries newest→oldest, so a resume against only
 * the newest (empty) file would miss the previous run's graph_checkpoint.
 * Merging all files oldest-first restores the global newest→oldest view.
 */
async function readAllSessionEntries(swarmDir: string): Promise<Array<Record<string, unknown>>> {
	const sessionDir = path.join(swarmDir, ".session");
	let files: string[];
	try {
		files = (await fs.readdir(sessionDir)).filter(f => f.endsWith(".jsonl")).map(f => path.join(sessionDir, f));
	} catch {
		return [];
	}

	const withMtime = await Promise.all(files.map(async f => ({ f, mtimeMs: (await fs.stat(f)).mtimeMs })));
	withMtime.sort((a, b) => a.mtimeMs - b.mtimeMs);

	const entries: Array<Record<string, unknown>> = [];
	for (const { f } of withMtime) {
		const text = await Bun.file(f).text();
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				entries.push(JSON.parse(trimmed) as Record<string, unknown>);
			} catch {
				/* skip malformed line */
			}
		}
	}
	return entries;
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

	// GraphRunner handles its own YAML parsing (graph.yaml format)
	const def: SwarmDefinition = {
		name: path.basename(yamlPath, path.extname(yamlPath)),
		workspace: cwd,
		mode: "loop",
		targetCount: 0,
		agents: new Map(),
		agentOrder: [],
		loopConfig: undefined,
	};

	const swarmName = def.name;

	const { shared, factory } = await createSwarmServices(cwd, yamlPath, def);

	try {
		const registry = new SessionRegistry(shared, factory, 1);
		const session = await registry.createSession(swarmName);

		process.stderr.write(`Starting swarm "${swarmName}"…\n`);

		const result = await session.runManager.start();
		if (!result.success) {
			process.stderr.write(`Swarm failed: ${result.error ?? "unknown error"}\n`);
			process.exitCode = 1;
			return;
		}

		// GraphRunnerAsRunManager handles completion internally.
		process.stderr.write(`Graph "${swarmName}" started.\n`);
	} finally {
		await shared.profileRegistry.save(cwd);
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

	// State variables for the REPL
	let phase: string = "idle";
	let busy = false;
	let planReady = false;
	let conversationLength = 0;

	try {
		// Create shared services (reuse createSwarmServices for consistency).
		// We only need `shared`; the factory and session are unused in plan mode.
		const { shared } = await createSwarmServices(cwd, yamlPath, def);
		const swarmDir = path.join(shared.workspace, ".stp", "sessions", `swarm-${swarmName}`);
		await fs.mkdir(swarmDir, { recursive: true });

		const infra = await createSwarmInfra({
			workspace: shared.workspace,
			swarmDir,
			swarmName,
			modelRegistry: shared.modelRegistry,
			settings: shared.settings,
			profileRegistry: shared.profileRegistry,
			startPhase: "script",
		});
		const bridge = new GraphRunner({
			workspace: shared.workspace,
			swarmDir,
			modelRegistry: shared.modelRegistry,
			settings: shared.settings,
			profileRegistry: shared.profileRegistry,
			autoApplaud: true,
			infra,
			onPhaseChange: p => setCurrentSwarmPhase(p),
			debateRoundtableFactory: config => new DebateRoundtable(config),
			readSessionEntries: () => SwarmSessionManager.readRawEntries(swarmDir),
		});
		await bridge.init();
		phase = "script";

		process.stderr.write("\n");
		process.stderr.write("╔══════════════════════════════════════════════╗\n");
		process.stderr.write("║  SatoPi Swarm Plan — Interactive Planner      ║\n");
		process.stderr.write(`║  Swarm: ${swarmName.padEnd(36)}║\n`);
		process.stderr.write("╚══════════════════════════════════════════════╝\n");
		process.stderr.write("\nCommands: /send <text>, /debate, /confirm [N], /status, /cancel, /quit\n");
		process.stderr.write("Type a message and press Enter to chat with the planner.\n\n");

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

			if (input.startsWith("/")) {
				const [slashCmd, ...rest] = input.slice(1).split(/\s+/);
				switch (slashCmd) {
					case "send": {
						const text = rest.join(" ");
						if (!text) {
							process.stderr.write("Usage: /send <text>\n");
							break;
						}
						await sendToPlanner(bridge, text);
						conversationLength++;
						break;
					}
					case "debate": {
						if (busy) {
							process.stderr.write("The planner is still thinking. Please wait.\n");
							break;
						}
						busy = true;
						try {
							const planPath = getSessionPlanPath(swarmDir);
							let planContent: string;
							try {
								planContent = await Bun.file(planPath).text();
							} catch {
								process.stderr.write("No plan.md found. Ask the planner to generate one first.\n");
								busy = false;
								break;
							}
							process.stderr.write("Starting plan debate...\n");
							const debate = new DebateRoundtable({
								agentCount: 2,
								maxRounds: 2,
								convergenceThreshold: 2,
								runtime: bridge.runtime,
							});
							const result = await debate.debate(
								planContent,
								shared.workspace,
								shared.modelRegistry,
								shared.settings,
							);
							await Bun.write(planPath, result.refinedPlan);
							bridge.onPlanUpdated(result.refinedPlan);
							planReady = true;
							process.stderr.write(
								`Debate ${result.converged ? "converged" : "completed"}. ` +
									`Review the plan and /confirm to begin.\n`,
							);
						} catch (err) {
							process.stderr.write(`Debate failed: ${String(err)}\n`);
						} finally {
							busy = false;
						}
						break;
					}
					case "confirm": {
						const agentCount = rest[0] ? parseInt(rest[0], 10) : undefined;
						const errors = await bridge.confirmScript(agentCount ? { agentCount } : undefined);
						if (errors.length === 0) {
							process.stderr.write("Plan confirmed. Starting stage execution...\n");
							rl.close();
						} else {
							process.stderr.write(`Cannot confirm: ${errors.join("; ")}\n`);
						}
						break;
					}
					case "status": {
						process.stderr.write(
							`Phase: ${phase} | Busy: ${busy} | ` +
								`Plan ready: ${planReady || bridge.isPlanReady()} | ` +
								`Conversation: ${conversationLength} turns\n`,
						);
						break;
					}
					case "cancel": {
						await bridge.dispose();
						phase = "idle";
						busy = false;
						planReady = false;
						conversationLength = 0;
						process.stderr.write("Script phase cancelled.\n");
						break;
					}
					case "quit":
					case "exit": {
						await bridge.dispose();
						rl.close();
						return;
					}
					default:
						process.stderr.write(`Unknown command: /${slashCmd}\n`);
				}
				rl.prompt();
				return;
			}

			// Regular message: start planner or send follow-up
			if (busy) {
				process.stderr.write("The planner is still thinking. Please wait.\n");
				rl.prompt();
				return;
			}
			busy = true;
			try {
				await sendToPlanner(bridge, input);
				conversationLength++;
				// Check if plan.md was created/updated
				const planPath = getSessionPlanPath(swarmDir);
				try {
					const stat = await fs.stat(planPath);
					if (stat.size > 0) {
						const content = await Bun.file(planPath).text();
						bridge.onPlanUpdated(content);
						planReady = bridge.isPlanReady();
						if (planReady) {
							process.stderr.write("Plan draft is ready. Use /debate to refine or /confirm to begin.\n");
						}
					}
				} catch {
					/* plan.md not created yet */
				}
			} catch (err) {
				process.stderr.write(`Planner error: ${String(err)}\n`);
			} finally {
				busy = false;
			}
			rl.prompt();
		});

		rl.on("close", () => {
			process.stderr.write("\nExiting plan mode.\n");
		});

		await new Promise<void>(resolve => {
			rl.on("close", () => resolve());
		});
	} finally {
		authStorage.close();
	}
}

/** Spawn planner agent and wait for response. */
async function sendToPlanner(bridge: GraphRunner, text: string): Promise<void> {
	const runtime = bridge.runtime;
	await runtime.ircBus.receiveFromHuman(text, "planner");
	const [planner] = await runtime.spawn([
		{
			id: "planner",
			role: "planner",
			roleSource: "library",
			task: text,
			modelPreference: "smartest",
		},
	]);
	const result = await planner.wait();
	if (result?.output) {
		process.stderr.write(`\nPlanner: ${String(result.output).slice(0, 500)}...\n\n`);
	}
}

// ============================================================================
// resume — continue a graph run from its last checkpoint
// ============================================================================

async function runSwarmResume(cmd: SwarmCommandArgs): Promise<void> {
	const sessionName = cmd.target;
	const cwd = getProjectDir();

	// Graph-mode sessions live in .stp/sessions/swarm-<name>; the original
	// yaml must still exist in the workspace to rebuild the execution waves.
	const swarmDir = path.join(cwd, ".stp", "sessions", `swarm-${sessionName}`);
	try {
		if (!(await fs.stat(swarmDir)).isDirectory()) throw new Error("not a directory");
	} catch {
		process.stderr.write(`No swarm session "${sessionName}" found (expected ${swarmDir}).\n`);
		process.exitCode = 1;
		return;
	}

	const yamlPath = await resolveGraphYamlForSession(cwd, sessionName);
	if (!yamlPath) {
		process.stderr.write(`Cannot resume "${sessionName}": no ${sessionName}.graph.yaml found in the workspace.\n`);
		process.exitCode = 1;
		return;
	}

	const def: SwarmDefinition = {
		name: sessionName,
		workspace: cwd,
		mode: "loop",
		targetCount: 0,
		agents: new Map(),
		agentOrder: [],
		loopConfig: undefined,
	};

	// Resume reads across all session files so checkpoint recovery sees the
	// previous run's graph_checkpoint (each run rotates to a fresh file).
	const { shared, factory } = await createSwarmServices(cwd, yamlPath, def, { resume: true });

	try {
		const registry = new SessionRegistry(shared, factory, 1);
		const session = await registry.createSession(sessionName);

		process.stderr.write(`Resuming swarm "${sessionName}"…\n`);

		const result = await session.runManager.resume();
		if (!result.success) {
			process.stderr.write(`Resume failed: ${result.error ?? "unknown error"}\n`);
			process.exitCode = 1;
			return;
		}

		// GraphRunnerAsRunManager resumes the graph from its checkpoint.
		process.stderr.write(`Graph "${sessionName}" resumed.\n`);
	} finally {
		await shared.profileRegistry.save(cwd);
	}
}

/**
 * Locate the `<name>.graph.yaml` backing a graph-mode swarm session.
 * Sessions are keyed by yaml basename (`.stp/sessions/swarm-<name>`), so
 * resume must re-find the original yaml to rebuild execution waves. Prefers
 * the shallowest match; skips vendor/build directories.
 */
async function resolveGraphYamlForSession(cwd: string, sessionName: string): Promise<string | null> {
	const wanted = `${sessionName}.graph.yaml`;
	const matches: string[] = [];
	const skipped: Record<string, true> = {
		".git": true,
		".stp": true,
		node_modules: true,
		dist: true,
		build: true,
		".bun": true,
	};

	async function walk(dir: string, depth: number): Promise<void> {
		if (depth > 8) return;
		let entries: Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (skipped[entry.name]) continue;
				await walk(path.join(dir, entry.name), depth + 1);
			} else if (entry.name === wanted) {
				matches.push(path.join(dir, entry.name));
			}
		}
	}

	await walk(cwd, 0);
	if (matches.length === 0) return null;
	matches.sort((a, b) => a.split("/").length - b.split("/").length);
	return matches[0];
}
