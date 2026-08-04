/**
 * assembler.ts — Unified service assembly for swarm CLI/TUI mode.
 *
 * Creates the full SwarmRuntime dependency graph with proper DI:
 *   RoleProvider + ContextPipeline + IrcBus
 *   → SwarmRuntime
 *
 * All services are created fresh per session — no global singletons.
 * The IrcBus is the single exception (SatoPi owns it); we accept
 * the global instance and inject it explicitly.
 */

import type { ProfileRegistry } from "../../agent/agent-profile";
import type { RoleAssetManager } from "../../agent/role-asset";
import { RoleProvider } from "../../agent/role-provider";
import { CommChannel } from "../../comm/comm-channel";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { ContextPipeline } from "../../context/context-pipeline";
import { ExperienceSource } from "../../context/sources/experience-source";
import { HindsightSource } from "../../context/sources/hindsight-source";
import { MmdSource } from "../../context/sources/mmd-source";
import { MnemopiSource } from "../../context/sources/mnemopi-source";
import { OffloadSource } from "../../context/sources/offload-source";
import { PeerRosterSource } from "../../context/sources/peer-roster-source";
import { StigmergySource } from "../../context/sources/stigmergy-source";
import { TaskQueueSource } from "../../context/sources/task-queue-source";
import { MarkEnvironment } from "../../coordination";
import type { ExperienceStore } from "../../experience/experience";
import { spawnAgent } from "../../graph/agent-helpers";
import { TaskQueue } from "../../graph/task-queue";
import { HookPipeline } from "../../hooks/hook-pipeline";
import { type BuiltinHookDeps, registerBuiltinHooks } from "../../hooks/register-builtins";
import type { ActivityLogger } from "../../infra/activity-logger";
import type { IrcBus } from "../../irc/bus";
import type { IOffloadManager } from "../../offload/manager";
import type { Tool } from "../../tools";
import type { SwarmHindsightClient } from "../infra/hindsight-adapter";
import type { MnemopiClient } from "../infra/mnemopi-adapter";
import type { SwarmRuntime } from "./swarm-runtime";

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
	/** Runtime-owned TaskQueue shared with StageBehavior — enables TaskQueueSource. */
	taskQueue?: TaskQueue;
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
	runtime: SwarmRuntime;
	hookPipeline: HookPipeline;
	markEnvironment: MarkEnvironment;
} {
	// Runtime-owned TaskQueue — StageBehavior adopts it during Stage so workers
	// (and TaskQueueSource context) see the live shared queue state.
	const taskQueue = new TaskQueue([]);
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
		taskQueue,
	});

	return { runtime, hookPipeline, markEnvironment };
}

// ============================================================================
// Assembler
// ============================================================================
export function assembleAgentRuntime(opts: AssemblerOptions): SwarmRuntime {
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

	// PeerRosterSource needs no dependencies — always inject so every spawned
	// agent sees who it is collaborating with.
	contextPipeline.register(new PeerRosterSource());

	// TaskQueueSource shows the shared stage task queue (in-progress, ready,
	// blocked) to Stage workers. Only registered when a runtime queue exists.
	if (opts.taskQueue) {
		contextPipeline.register(new TaskQueueSource(opts.taskQueue));
	}

	if (opts.ircBus) {
		opts.ircBus.setActivityLogger(opts.activityLogger);
		opts.ircBus.setHookPipeline(opts.hookPipeline);
	}

	const ircBus = opts.ircBus!;

	// Runtime-level CommChannel (same role as AgentRuntime.#commChannel)
	const commChannel = new CommChannel(
		ircBus,
		[], // members added as agents spawn
		["human"], // human is always an observer
		opts.activityLogger,
		opts.hookPipeline,
	);

	// Per-agent steering queues — populated by sendHumanMessage, drained by the agent loop
	const steeringQueues = new Map<
		string,
		Array<{ role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }>
	>();

	const runtime: SwarmRuntime = {
		contextPipeline,
		ircBus,
		taskQueue: opts.taskQueue,

		async spawn(specs) {
			const sessions = await Promise.all(
				specs.map(async spec => {
					const steeringQueue: Array<{
						role: "user";
						content: Array<{ type: "text"; text: string }>;
						timestamp: number;
					}> = [];
					steeringQueues.set(spec.id, steeringQueue);
					return spawnAgent({
						spec,
						roleProvider,
						contextPipeline,
						hookPipeline: opts.hookPipeline,
						modelRegistry: opts.modelRegistry,
						settings: opts.settings,
						commChannel,
						steeringQueue,
					});
				}),
			);
			return sessions;
		},

		async sendHumanMessage(agentId, text) {
			const queue = steeringQueues.get(agentId) ?? [];
			queue.push({
				role: "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
			});
			steeringQueues.set(agentId, queue);
			// Route through CommChannel for real-time IRC delivery
			await commChannel.interrupt("human", agentId, text);
		},
	};

	return runtime;
}
