/**
 * assembler.ts — Unified service assembly for swarm CLI/TUI mode.
 *
 * Creates the full AgentRuntime dependency graph with proper DI:
 *   RoleProvider + ContextPipeline + IrcBus
 *   → AgentRuntime
 *
 * All services are created fresh per session — no global singletons.
 * The IrcBus is the single exception (SatoPi owns it); we accept
 * the global instance and inject it explicitly.
 */

import type { ProfileRegistry } from "../../agent/agent-profile";
import type { RoleAssetManager } from "../../agent/role-asset";
import { RoleProvider } from "../../agent/role-provider";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { MarkEnvironment } from "../../coordination";
import type { IrcBus } from "../../irc/bus";
import type { IOffloadManager } from "../../offload/manager";
import type { Tool } from "../../tools";
import { AgentRuntime } from "../agent-runtime";

import { ContextPipeline } from "../context-manager/context-pipeline";
import { ExperienceSource } from "../context-manager/sources/experience-source";
import { HindsightSource } from "../context-manager/sources/hindsight-source";
import { MmdSource } from "../context-manager/sources/mmd-source";
import { MnemopiSource } from "../context-manager/sources/mnemopi-source";
import { OffloadSource } from "../context-manager/sources/offload-source";
import { StigmergySource } from "../context-manager/sources/stigmergy-source";
import type { ExperienceStore } from "../../experience/experience";
import { HookPipeline } from "../../hooks/hook-pipeline";
import { type BuiltinHookDeps, registerBuiltinHooks } from "../../hooks/register-builtins";
import type { ActivityLogger } from "../../infra/activity-logger";
import type { SwarmHindsightClient } from "../infra/hindsight-adapter";
import type { MnemopiClient } from "../infra/mnemopi-adapter";

// ============================================================================
// Types
// ============================================================================

export interface AssemblerOptions {
	modelRegistry: ModelRegistry;
	settings: Settings;
	activityLogger: ActivityLogger;
	roleAssetManager: RoleAssetManager;
	profileRegistry?: ProfileRegistry;
	hookPipeline: HookPipeline;
	ircBus?: IrcBus;
	toolRegistry?: Map<string, Tool>;
	experienceStore?: ExperienceStore;
	hindsightClient?: SwarmHindsightClient | null;
	mnemopiClient?: MnemopiClient | null;
	markEnvironment?: MarkEnvironment;
	offloadManager?: IOffloadManager;
	activeMmd?: string;
}

// ============================================================================
// Orchestrator Runtime Factory
// ============================================================================

export interface CreateOrchestratorRuntimeOptions {
	modelRegistry: ModelRegistry;
	settings: Settings;
	activityLogger: ActivityLogger;
	roleAssetManager: RoleAssetManager;
	experienceStore: ExperienceStore;
	profileRegistry?: ProfileRegistry;
	offloadManager?: IOffloadManager;
	ircBus?: IrcBus;
	toolRegistry?: Map<string, Tool>;
	activeMmd?: string;
}

export function createOrchestratorRuntime(opts: CreateOrchestratorRuntimeOptions): {
	runtime: AgentRuntime;
	hookPipeline: HookPipeline;
	markEnvironment: MarkEnvironment;
} {
	const markEnvironment = new MarkEnvironment();
	const hookPipeline = new HookPipeline();

	const hookDeps: BuiltinHookDeps = {
		profileRegistry: opts.profileRegistry,
		markEnvironment,
		offloadManager: opts.offloadManager,
		experienceStore: opts.experienceStore,
	};
	registerBuiltinHooks(hookPipeline, hookDeps);

	const runtime = assembleAgentRuntime({
		modelRegistry: opts.modelRegistry,
		settings: opts.settings,
		activityLogger: opts.activityLogger,
		roleAssetManager: opts.roleAssetManager,
		hookPipeline,
		ircBus: opts.ircBus,
		toolRegistry: opts.toolRegistry,
		experienceStore: opts.experienceStore,
		activeMmd: opts.activeMmd,
		markEnvironment,
		offloadManager: opts.offloadManager,
	});

	return { runtime, hookPipeline, markEnvironment };
}

// ============================================================================
// Assembler
// ============================================================================

export function assembleAgentRuntime(opts: AssemblerOptions): AgentRuntime {
	const roleProvider = new RoleProvider(opts.roleAssetManager, opts.profileRegistry);

	const contextPipeline = new ContextPipeline();
	if (opts.experienceStore) {
		contextPipeline.register(new ExperienceSource(opts.experienceStore));
	}
	if (opts.mnemopiClient) {
		contextPipeline.register(new MnemopiSource(opts.mnemopiClient));
	}
	if (opts.hindsightClient) {
		contextPipeline.register(new HindsightSource(opts.hindsightClient));
	}
	if (opts.activeMmd) {
		contextPipeline.register(new MmdSource(opts.activeMmd));
	}
	if (opts.markEnvironment) {
		contextPipeline.register(new StigmergySource(opts.markEnvironment));
	}
	if (opts.offloadManager) {
		contextPipeline.register(new OffloadSource(opts.offloadManager));
	}

	if (opts.ircBus) {
		opts.ircBus.setActivityLogger(opts.activityLogger);
		opts.ircBus.setHookPipeline(opts.hookPipeline);
	}

	return new AgentRuntime({
		roleProvider,
		contextPipeline,
		ircBus: opts.ircBus,
		hookPipeline: opts.hookPipeline,
		modelRegistry: opts.modelRegistry,
		settings: opts.settings,
		activityLogger: opts.activityLogger,
		toolRegistry: opts.toolRegistry,
	});
}
