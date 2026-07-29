/**
 * AgentRuntime — The single entry point for spawning swarm agents.
 *
 * All phases (script, stage, curtain) use AgentRuntime.spawn() or
 * AgentRuntime.spawnRoundtable() to launch agents from declarative specs.
 *
 * The runtime orchestrates:
 * 1. Hook triggers (agent:beforeSpawn / agent:afterSpawn)
 * 2. Role resolution (RoleProvider)
 * 3. Context assembly (ContextPipeline)
 * 4. AgentLoopConfig assembly (transformContext, getSteeringMessages, etc.)
 * 5. Agent launch (AgentLauncher)
 *
 * Part of the AgentRuntime system (Phase 3A of the swarm v3 unified architecture).
 */

import type { AgentMessage, AsideMessage } from "@satopi/pi-agent-core";
import type { ModelRegistry, Settings } from "@satopi/pi-coding-agent";
import { logger } from "@satopi/pi-utils";
import type { ResolvedRole, RoleProvider } from "../../agent/role-provider";
import type { IrcBus } from "../../irc/bus";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import type { Tool } from "../../tools";
import { CommChannel } from "../comm-bus";
import type { AssembledContext, ContextPipeline, PhaseInfo } from "../context-manager/context-pipeline";
import type { HookPipeline } from "../hook-system/hook-pipeline";
import type { ActivityLogger } from "../infra/activity-logger";
import type { AgentLauncher, LaunchContext } from "./agent-launcher";
import type { AgentSpec } from "./agent-spec";

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for a roundtable discussion among multiple agents.
 */
export interface RoundtableConfig {
	/** Number of discussion rounds. */
	rounds: number;

	/** Per-round timeout in milliseconds. */
	timeoutMs?: number;

	/** Convergence threshold for early exit (Jaccard similarity, 0-1). */
	convergenceThreshold?: number;

	/** Consecutive rounds above threshold before early exit. */
	convergenceStreak?: number;
}

/**
 * Result of a roundtable discussion.
 */
export interface RoundtableResult {
	/** Whether the roundtable converged before exhausting all rounds. */
	converged: boolean;

	/** Number of rounds actually executed. */
	rounds: number;

	/** All response strings across all rounds. */
	responses: string[];

	/** Final positions from the last round. */
	finalPositions: string[];
}

/**
 * Options for the AgentRuntime constructor.
 */
export interface AgentRuntimeOptions {
	/** Shared service for role resolution. */
	roleProvider: RoleProvider;

	/** Shared service for context assembly. */
	contextPipeline: ContextPipeline;

	/** Shared service for agent creation + launch. */
	launcher: AgentLauncher;

	/** Communication bus for human steering and system messages. Defaults to IrcBus.global(). */
	ircBus?: IrcBus;

	/** Hook pipeline for lifecycle events. */
	hookPipeline: HookPipeline;

	/** Model registry (needed for LaunchContext modelRegistry). */
	modelRegistry: ModelRegistry;

	/** Settings (needed for LaunchContext settings). */
	settings: Settings;

	/** Optional activity logger for streaming output. */
	activityLogger?: ActivityLogger;

	/** Optional tool registry for resolving tool names to real Tool instances. */
	toolRegistry?: Map<string, Tool>;
}

// ============================================================================
// AgentRuntime
// ============================================================================

/**
 * The central agent lifecycle controller.
 *
 * Usage:
 * ```ts
 * const runtime = new AgentRuntime({
 *   roleProvider, contextPipeline, launcher, ircBus, hookPipeline,
 * });
 *
 * const handles = await runtime.spawn([
 *   { id: "planner", role: "planner", roleSource: "library", task: "Plan the build" },
 *   { id: "agent-1", role: "backend-dev", roleSource: "library", task: "Build API" },
 * ]);
 *
 * const results = await Promise.all(handles.map(h => h.wait()));
 * ```
 */
export class AgentRuntime {
	readonly #roleProvider: RoleProvider;
	readonly #contextPipeline: ContextPipeline;
	readonly #launcher: AgentLauncher;
	readonly #ircBus: IrcBus;
	readonly #hookPipeline: HookPipeline;
	readonly #modelRegistry: ModelRegistry;
	readonly #settings: Settings;
	readonly #activityLogger?: ActivityLogger;
	readonly #toolRegistry?: Map<string, Tool>;

	/** Runtime-level CommChannel wrapping all spawned agents for inter-agent communication. */
	readonly #commChannel: CommChannel;

	/** Per-agent queues for system notification (aside) messages — drained by hookProviders. */
	readonly #asideQueues = new Map<string, AsideMessage[]>();
	/** Per-agent queues for human steering messages — drained by hookProviders. */
	readonly #steeringQueues = new Map<string, AgentMessage[]>();
	/** Per-agent queues for follow-up messages — drained by hookProviders. */
	readonly #followUpQueues = new Map<string, AgentMessage[]>();

	constructor(options: AgentRuntimeOptions) {
		this.#roleProvider = options.roleProvider;
		this.#contextPipeline = options.contextPipeline;
		this.#launcher = options.launcher;
		this.#ircBus = options.ircBus!;
		this.#hookPipeline = options.hookPipeline;
		this.#modelRegistry = options.modelRegistry;
		this.#settings = options.settings;
		this.#activityLogger = options.activityLogger;
		this.#toolRegistry = options.toolRegistry;
		this.#commChannel = new CommChannel(
			this.#ircBus!,
			[], // members added as agents spawn
			["human"], // human is always an observer
			this.#activityLogger,
			this.#hookPipeline,
		);
	}

	// -----------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------

	/**
	 * Spawn one or more agents from declarative specs.
	 *
	 * All phases use this single entry point. Agents are spawned in parallel
	 * when multiple specs are provided.
	 *
	 * @returns AgentSession[] — each session provides wait(), steer(), abort()
	 */
	async spawn(specs: AgentSpec[]): Promise<AgentSession[]> {
		const sessions = await Promise.all(specs.map(spec => this.#spawnOne(spec)));
		return sessions;
	}

	/**
	 * Spawn agents and run a structured roundtable discussion via CommChannel.
	 *
	 * Agents are spawned once, then CommChannel.roundtable() runs the
	 * multi-round discussion among the live agent sessions. Convergence
	 * is detected via Jaccard text similarity (delegated to CommChannel).
	 */
	async spawnRoundtable(specs: AgentSpec[], config: RoundtableConfig): Promise<RoundtableResult> {
		if (specs.length === 0) {
			return { converged: true, rounds: 0, responses: [], finalPositions: [] };
		}

		// 1. Spawn all agents once
		await this.spawn(specs);

		// 2. Register agents in the runtime-level CommChannel
		for (const spec of specs) {
			this.#commChannel.addMember(spec.id);
		}

		// 3. Build roundtable topic from agent tasks
		const topic = specs.map(s => `[${s.id}] ${s.task}`).join("\n\n");

		// 4. Delegate multi-round discussion to CommChannel
		const channelResult = await this.#commChannel.roundtable(topic, {
			rounds: config.rounds,
			timeoutMs: config.timeoutMs ?? 30_000,
			convergenceThreshold: config.convergenceThreshold,
			convergenceStreak: config.convergenceStreak,
			agentIds: specs.map(s => s.id),
		});

		// 5. Map CommChannel result to AgentRuntime shape
		return {
			converged: channelResult.converged,
			rounds: channelResult.rounds,
			responses: channelResult.responses,
			finalPositions: channelResult.finalPositions,
		};
	}

	/**
	 * Queue a human steering message for a specific agent.
	 *
	 * The message is pushed to the steering queue (drained by hookProviders)
	 * and routed through CommChannel.interrupt() for real-time IRC delivery.
	 */
	async sendHumanMessage(agentId: string, text: string): Promise<void> {
		// Push to steering queue (drained by hookProviders.getSteeringMessages)
		const queue = this.#steeringQueues.get(agentId) ?? [];
		queue.push({
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		});
		this.#steeringQueues.set(agentId, queue);
		// Route through CommChannel for real-time IRC delivery
		await this.#commChannel.interrupt("human", agentId, text);
	}

	/**
	 * Queue a system notification (aside message) for a specific agent.
	 *
	 * Pushed to the aside queue for hookProvider draining and also broadcast
	 * through CommChannel for real-time delivery to observing agents.
	 */
	async sendSystemNotification(agentId: string, text: string): Promise<void> {
		const queue = this.#asideQueues.get(agentId) ?? [];
		queue.push({
			role: "user",
			content: [{ type: "text", text: `[System] ${text}` }],
			timestamp: Date.now(),
		});
		this.#asideQueues.set(agentId, queue);
		// Also route through CommChannel for real-time delivery
		await this.#commChannel.send("system", `[System] ${text}`);
	}

	/** The communication bus for human steering and agent messaging. */
	get ircBus(): IrcBus {
		return this.#ircBus!;
	}

	/** The runtime-level CommChannel for inter-agent communication. */
	get commChannel(): CommChannel {
		return this.#commChannel;
	}

	/** The context pipeline for registering additional context sources. */
	get contextPipeline(): ContextPipeline {
		return this.#contextPipeline;
	}

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	/**
	 * Spawn a single agent from its spec.
	 *
	 * Full lifecycle:
	 * 1. HookPipeline.trigger("agent:beforeSpawn")
	 * 2. RoleProvider.resolve(spec)
	 * 3. ContextPipeline.assemble(spec, phase, base)
	 * 4. Build AgentLoopConfig hooks from CommChannel-backed queues
	 * 5. AgentLauncher.launch(launchContext)
	 * 6. HookPipeline.trigger("agent:afterSpawn")
	 */
	async #spawnOne(spec: AgentSpec): Promise<AgentSession> {
		const agentId = spec.id;

		// 1. Before-spawn hook
		await this.#hookPipeline.trigger(
			"agent:beforeSpawn",
			{ agentId, role: spec.role, task: spec.task },
			{ agentId, phase: "idle" },
		);

		// 2. Resolve role
		let resolvedRole: ResolvedRole;
		try {
			resolvedRole = await this.#roleProvider.resolve(spec);
		} catch (err) {
			logger.error("[AgentRuntime] Role resolution failed", {
				agentId,
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}

		// 3. Assemble context via ContextPipeline
		//    Use spec.phase when the caller provides it; fall back to "stage"
		//    so phase-filtered sources (e.g. ExperienceSource for "script"
		//    / "script-debate") fire correctly.
		const phaseInfo: PhaseInfo = {
			phase: spec.phase ?? "stage",
			multiAgent: true,
			humanMode: "observer",
		};

		const baseContext = {
			taskDescription: spec.task,
			workspace: process.cwd(),
			swarmDir: ".stp",
			turnNumber: 0,
			phase: phaseInfo,
			accumulated: undefined as unknown as Partial<AssembledContext>,
		};

		let assembledContext: AssembledContext;
		try {
			assembledContext = await this.#contextPipeline.assemble(
				{ id: spec.id, role: spec.role, task: spec.task },
				phaseInfo,
				baseContext,
			);
		} catch (err) {
			logger.error("[AgentRuntime] Context assembly failed", {
				agentId,
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}

		// 4. Build AgentLoopConfig hook providers from CommChannel-backed queues
		const hookProviders: LaunchContext["hookProviders"] = {
			getAsideMessages: async () => {
				const queue = this.#asideQueues.get(agentId);
				if (!queue || queue.length === 0) return [];
				const messages = queue.splice(0);
				this.#asideQueues.delete(agentId);
				return messages;
			},
			getSteeringMessages: async () => {
				const queue = this.#steeringQueues.get(agentId);
				if (!queue || queue.length === 0) return [];
				const messages = queue.splice(0);
				this.#steeringQueues.delete(agentId);
				return messages;
			},
			getFollowUpMessages: async () => {
				const queue = this.#followUpQueues.get(agentId);
				if (!queue || queue.length === 0) return [];
				const messages = queue.splice(0);
				this.#followUpQueues.delete(agentId);
				return messages;
			},
		};

		// 4.5 Register persistent agent in global AgentRegistry
		if (spec.profileId) {
			AgentRegistry.global().register({
				id: spec.id,
				displayName: spec.id,
				kind: "persistent",
				parentId: "Main",
				session: null,
				sessionFile: null,
				profileId: spec.profileId,
				role: spec.role,
			});
		}

		// 5. Build launch context and launch
		const launchContext: LaunchContext = {
			spec,
			resolvedRole,
			assembledContext,
			hookProviders,
			modelRegistry: this.#modelRegistry,
			settings: this.#settings,
			activityLogger: this.#activityLogger,
			toolRegistry: this.#toolRegistry,
			agentRuntime: this,
			pipeline: this.#contextPipeline,
		};

		let session: AgentSession;
		try {
			session = await this.#launcher.launch(launchContext);

			// 5.5 Store session for persistent agent steering/reuse
			if (spec.profileId) {
				AgentRegistry.global().setHandle(spec.id, session);
			}
		} catch (err) {
			logger.error("[AgentRuntime] Agent launch failed", {
				agentId,
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}

		// 5.6 Register agent in the runtime-level CommChannel
		this.#commChannel.addMember(agentId);

		// 6. After-spawn hook
		await this.#hookPipeline.trigger(
			"agent:afterSpawn",
			{ agentId, role: spec.role, session },
			{ agentId, phase: spec.phase ?? "stage" },
		);

		// 6.5 Persistent agent lifecycle: status is tracked by AgentSession.status
		//     and surfaced via AgentRegistry — no explicit wiring needed.

		return session;
	}
}
