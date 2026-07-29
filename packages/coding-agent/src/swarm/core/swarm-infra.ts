/**
 * swarm-infra.ts — Shared swarm infrastructure factory.
 *
 * Creates the common set of swarm services that both EmbeddedSwarmBridge
 * and GraphRunner need during init():
 *   SwarmSessionManager, StateTracker, ActivityLogger, WorkflowFSM,
 *   ExperienceStore, RoleAssetManager, and the orchestrator runtime
 *   (HookPipeline + MarkEnvironment + AgentRuntime).
 *
 * Both orchestrators call this once, then add their own specializations
 * (FSM onChange listener, graph loading, gate controller, etc.).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ModelRegistry, Settings } from "@satopi/pi-coding-agent";
import type { ProfileRegistry } from "../../agent/agent-profile";
import { RoleAssetManager, type RoleAssetManager as RoleAssetManagerType } from "../../agent/role-asset";
import type { MarkEnvironment } from "../../coordination/mark-environment";
import { IrcBus } from "../../irc/bus";
import type { AgentRuntime } from "../agent-runtime";
import { ExperienceStore } from "../curtain/experience";
import type { HookPipeline } from "../hook-system/hook-pipeline";
import { ActivityLogger } from "../infra/activity-logger";
import { SwarmSessionManager } from "../session/swarm-session-manager";
import { createOrchestratorRuntime } from "./assembler";
import { type Chapter, StateTracker } from "./state";
import { PHASES, WorkflowFsm } from "./workflow-fsm";

// ============================================================================
// Types
// ============================================================================

export interface CreateSwarmInfraOptions {
	workspace: string;
	swarmDir: string;
	swarmName: string;
	modelRegistry: ModelRegistry;
	settings: Settings;
	profileRegistry?: ProfileRegistry;
	roleAssetManager?: RoleAssetManagerType;
	activeMmd?: string;
	startPhase: Chapter;
}

export interface SwarmInfra {
	sessionManager: SwarmSessionManager;
	stateTracker: StateTracker;
	activityLogger: ActivityLogger;
	fsm: WorkflowFsm;
	experienceStore: ExperienceStore;
	hookPipeline: HookPipeline;
	runtime: AgentRuntime;
	roleAssetManager: RoleAssetManagerType;
	markEnvironment: MarkEnvironment;
	ircBus: IrcBus;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create the shared swarm infrastructure.
 *
 * Both EmbeddedSwarmBridge and GraphRunner call this during init()
 * to create the common set of services, then add their own
 * specializations (FSM onChange listener, graph loading, etc.).
 */
export async function createSwarmInfra(opts: CreateSwarmInfraOptions): Promise<SwarmInfra> {
	const { workspace, swarmDir, swarmName, modelRegistry, settings, profileRegistry, activeMmd, startPhase } = opts;
	let { roleAssetManager } = opts;

	// 1. Create swarm workspace directories
	await fs.mkdir(swarmDir, { recursive: true });
	await fs.mkdir(path.join(swarmDir, ".session"), { recursive: true });

	// 2. SwarmSessionManager for persistence
	const sessionManager = await SwarmSessionManager.create(swarmDir);

	// 3. StateTracker
	const stateTracker = new StateTracker(workspace, swarmName);
	stateTracker.setSessionManager(sessionManager);

	// 4. ActivityLogger
	const activityLogger = new ActivityLogger(swarmDir, swarmName);
	activityLogger.setSessionManager(sessionManager);

	// 5. ExperienceStore
	const experienceStore = new ExperienceStore(workspace);
	await experienceStore.init();

	// 6. WorkflowFSM — each caller adds its own onChange listener
	const fsm = new WorkflowFsm(stateTracker, activityLogger, startPhase);
	for (const def of PHASES) fsm.registerPhase(def);

	// 7. IrcBus
	const ircBus = IrcBus.global();

	// 8. RoleAssetManager — auto-create if not provided
	if (!roleAssetManager) {
		roleAssetManager = new RoleAssetManager(workspace);
		await roleAssetManager.init();
	}

	// 9. Orchestrator runtime (MarkEnvironment + HookPipeline + builtins + AgentRuntime)
	const orch = createOrchestratorRuntime({
		modelRegistry,
		settings,
		activityLogger,
		roleAssetManager,
		experienceStore,
		profileRegistry,
		ircBus,
		activeMmd,
	});

	return {
		sessionManager,
		stateTracker,
		activityLogger,
		fsm,
		experienceStore,
		hookPipeline: orch.hookPipeline,
		runtime: orch.runtime,
		roleAssetManager,
		markEnvironment: orch.markEnvironment,
		ircBus,
	};
}
