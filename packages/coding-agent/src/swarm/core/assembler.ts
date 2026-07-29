/**
 * assembler.ts — Unified service assembly for swarm CLI/TUI mode.
 *
 * Creates the full AgentRuntime dependency graph with proper DI:
 *   RoleProvider + ContextPipeline + AgentLauncher + IrcBus
 *   → AgentRuntime
 *
 * All services are created fresh per session — no global singletons.
 * The IrcBus is the single exception (oh-my-pi owns it); we accept
 * the global instance and inject it explicitly.
 *
 * Usage:
 * ```ts
 * const runtime = assembleAgentRuntime({
 *   modelRegistry, settings, activityLogger,
 *   roleAssetManager, hookPipeline, ircBus,
 * });
 * scriptManager.setRuntime(runtime);
 * ```
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
import { AgentLauncher } from "../agent-runtime/agent-launcher";

import { ContextPipeline } from "../context-manager/context-pipeline";
import { ExperienceSource } from "../context-manager/sources/experience-source";
import { HindsightSource } from "../context-manager/sources/hindsight-source";
import { MmdSource } from "../context-manager/sources/mmd-source";
import { MnemopiSource } from "../context-manager/sources/mnemopi-source";
import { OffloadSource } from "../context-manager/sources/offload-source";
import { StigmergySource } from "../context-manager/sources/stigmergy-source";
import type { ExperienceStore } from "../curtain/experience";
import { HookPipeline } from "../hook-system/hook-pipeline";
import { type BuiltinHookDeps, registerBuiltinHooks } from "../hook-system/register-builtins";
import type { ActivityLogger } from "../infra/activity-logger";
import type { SwarmHindsightClient } from "../infra/hindsight-adapter";
import type { MnemopiClient } from "../infra/mnemopi-adapter";

// ============================================================================
// Types
// ============================================================================

export interface AssemblerOptions {
	/** Model registry for API key resolution and model selection. */
	modelRegistry: ModelRegistry;
	/** Settings for model and tool configuration. */
	settings: Settings;
	/** Activity logger for streaming output and event capture. */
	activityLogger: ActivityLogger;
	/** Role asset manager for library-based role resolution. */
	roleAssetManager: RoleAssetManager;
	/** Optional profile registry for profile-based role resolution. */
	profileRegistry?: ProfileRegistry;
	/** Hook pipeline for lifecycle events (already created by caller). */
	hookPipeline: HookPipeline;
	/** Optional IrcBus for agent-to-agent communication. */
	ircBus?: IrcBus;
	/** Optional tool registry for resolving tool names to real Tool instances. */
	toolRegistry?: Map<string, Tool>;
	/** Local experience store — enables ExperienceSource (past-run lessons). */
	experienceStore?: ExperienceStore;
	/** Remote Hindsight handle — enables HindsightSource (cross-session recall). Null when unconfigured. */
	hindsightClient?: SwarmHindsightClient | null;
	/** Semantic memory handle — enables MnemopiSource. Null when unavailable. */
	mnemopiClient?: MnemopiClient | null;
	/** MarkEnvironment for stigmergic coordination — enables StigmergySource. */
	markEnvironment?: MarkEnvironment;
	/** OffloadManager for context offload — enables OffloadSource (L1 summaries, MMD context). */
	offloadManager?: IOffloadManager;
	/** Active MMD content for MmdSource context injection. */
	activeMmd?: string;
}

// ============================================================================
// Orchestrator Runtime Factory
// ============================================================================

/** Options for createOrchestratorRuntime — the shared orchestrator bootstrap. */
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

/**
 * Create the shared orchestration runtime — MarkEnvironment, HookPipeline
 * with builtins, and a fully-wired AgentRuntime — in one call.
 *
 * Both EmbeddedSwarmBridge and GraphRunner use this to eliminate duplicated
 * bootstrap code.
 */
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

/**
 * Assemble a fully-wired AgentRuntime from shared services.
 *
 * This is the single entry point for creating an AgentRuntime in CLI/TUI mode.
 * It creates all internal services (RoleProvider, ContextPipeline, AgentLauncher,
 * IrcBus) and wires them into an AgentRuntime instance.
 *
 * The OffloadManager is NOT wired here — it's created later by SessionRegistry
 * once SessionStorage is available. The AgentLauncher handles the missing
 * OffloadManager gracefully (skips compaction).
 */
export function assembleAgentRuntime(opts: AssemblerOptions): AgentRuntime {
	// 1. RoleProvider — resolves AgentSpec.role → ResolvedRole
	const roleProvider = new RoleProvider(opts.roleAssetManager, opts.profileRegistry);

	// 2. ContextPipeline — assembles agent context from registered sources.
	//    Memory sources are registered when their backing handle is available;
	//    each source no-ops (or is skipped) when its dependency is absent, so an
	//    unconfigured environment degrades gracefully.
	//    AgentRuntime.spawnOne() uses spec.phase (when provided by the behavior)
	//    as BuildContext.phase, so phase-filtered sources like ExperienceSource
	//    ("script"/"script-debate" only) now fire correctly when the caller
	//    passes the real phase. Fallback is "stage" for backward compat.
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

	// 3. AgentLauncher — creates Agent instances with full hook wiring
	const launcher = new AgentLauncher(opts.modelRegistry, opts.settings);

	// 4. Wire IrcBus with activity logger and hook pipeline (ircBus is optional)
	if (opts.ircBus) {
		opts.ircBus.setActivityLogger(opts.activityLogger);
		opts.ircBus.setHookPipeline(opts.hookPipeline);
	}

	// 5. AgentRuntime — the central agent lifecycle controller
	return new AgentRuntime({
		roleProvider,
		contextPipeline,
		launcher,
		ircBus: opts.ircBus,
		hookPipeline: opts.hookPipeline,
		modelRegistry: opts.modelRegistry,
		settings: opts.settings,
		activityLogger: opts.activityLogger,
		toolRegistry: opts.toolRegistry,
	});
}
