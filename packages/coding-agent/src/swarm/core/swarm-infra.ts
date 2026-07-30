/**
 * swarm-infra.ts — Shared swarm infrastructure factory.
 *
 * Creates the common set of swarm services that GraphRunner needs
 * during init() for both graph mode and swarm keyword mode:
 *   SwarmSessionManager, StateTracker, ActivityLogger,
 *   ExperienceStore, RoleAssetManager, and the orchestrator runtime
 *   (HookPipeline + MarkEnvironment + AgentRuntime).
 *
 * GraphRunner calls this once, then adds its own specializations
 * (graph loading, node behaviors, gate controller, etc.).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ModelRegistry, Settings } from "@satopi/pi-coding-agent";
import type { ProfileRegistry } from "../../agent/agent-profile";
import { RoleAssetManager, type RoleAssetManager as RoleAssetManagerType } from "../../agent/role-asset";
import type { MarkEnvironment } from "../../coordination/mark-environment";
import { IrcBus } from "../../irc/bus";
import type { SwarmRuntime } from "./swarm-runtime";
import { ExperienceStore } from "../../experience/experience";
import type { HookPipeline } from "../../hooks/hook-pipeline";
import { ActivityLogger } from "../../infra/activity-logger";
import { SwarmSessionManager } from "../session/swarm-session-manager";
import { createOrchestratorRuntime } from "./assembler";
import { type Chapter, StateTracker } from "./state";

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
	experienceStore: ExperienceStore;
	hookPipeline: HookPipeline;
	runtime: SwarmRuntime;
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
 * GraphRunner calls this during init() to create the common set
 * of services, then adds its own specializations.
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

	// 6. Set initial phase via StateTracker
	await stateTracker.updatePipeline({ phase: startPhase });

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
		experienceStore,
		hookPipeline: orch.hookPipeline,
		runtime: orch.runtime,
		roleAssetManager,
		markEnvironment: orch.markEnvironment,
		ircBus,
	};
}
