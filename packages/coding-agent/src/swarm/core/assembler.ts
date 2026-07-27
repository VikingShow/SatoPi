/**
 * assembler.ts — Unified service assembly for swarm CLI/TUI mode.
 *
 * Creates the full AgentRuntime dependency graph with proper DI:
 *   RoleProvider + ContextPipeline + AgentLauncher + CommBus
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

import type { RoleAssetManager } from "../../agent/role-asset";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { IrcBus } from "../../irc/bus";
import { AgentRuntime } from "../agent-runtime";
import { AgentLauncher } from "../agent-runtime/agent-launcher";
import { RoleProvider } from "../agent-runtime/role-provider";
import { CommBus } from "../comm-bus/comm-bus";
import { ContextPipeline } from "../context-manager/context-pipeline";
import type { HookPipeline } from "../hook-system/hook-pipeline";
import type { ActivityLogger } from "../hooks/activity-logger";

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
	/** Hook pipeline for lifecycle events (already created by caller). */
	hookPipeline: HookPipeline;
	/** Optional IrcBus for agent-to-agent communication. */
	ircBus?: IrcBus;
}

// ============================================================================
// Assembler
// ============================================================================

/**
 * Assemble a fully-wired AgentRuntime from shared services.
 *
 * This is the single entry point for creating an AgentRuntime in CLI/TUI mode.
 * It creates all internal services (RoleProvider, ContextPipeline, AgentLauncher,
 * CommBus) and wires them into an AgentRuntime instance.
 *
 * The OffloadManager is NOT wired here — it's created later by SessionRegistry
 * once SessionStorage is available. The AgentLauncher handles the missing
 * OffloadManager gracefully (skips compaction).
 */
export function assembleAgentRuntime(opts: AssemblerOptions): AgentRuntime {
	// 1. RoleProvider — resolves AgentSpec.role → ResolvedRole
	const roleProvider = new RoleProvider(opts.roleAssetManager);

	// 2. ContextPipeline — assembles agent context from registered sources
	//    Empty for now; sources (OffloadSource, StigmergySource, etc.) can be
	//    registered later as the architecture evolves.
	const contextPipeline = new ContextPipeline();

	// 3. AgentLauncher — creates Agent instances with full hook wiring
	const launcher = new AgentLauncher(opts.modelRegistry, opts.settings);

	// 4. CommBus — human steering and system message routing
	const commBus = new CommBus(opts.ircBus, opts.activityLogger);

	// 5. AgentRuntime — the central agent lifecycle controller
	return new AgentRuntime({
		roleProvider,
		contextPipeline,
		launcher,
		commBus,
		hookPipeline: opts.hookPipeline,
		modelRegistry: opts.modelRegistry,
		settings: opts.settings,
		activityLogger: opts.activityLogger,
	});
}
