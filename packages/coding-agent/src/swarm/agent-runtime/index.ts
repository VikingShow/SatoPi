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

import type { AgentMessage, AsideMessage } from "@oh-my-pi/pi-agent-core";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import type { ResolvedRole, RoleProvider } from "../../agent/role-provider";
import type { IrcBus } from "../../irc/bus";
import { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import type { Tool } from "../../tools";
import type { AssembledContext, ContextPipeline, PhaseInfo } from "../context-manager/context-pipeline";
import { jaccardSimilarity } from "../core/convergence.js";
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

	/** Communication bus for human steering and system messages. */
	ircBus: IrcBus;

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

	/** Per-agent queues for system notification (aside) messages. */
	readonly #asideQueues = new Map<string, AsideMessage[]>();
	/** Per-agent queues for human steering messages (drained by hookProviders). */
	readonly #steeringQueues = new Map<string, AgentMessage[]>();
	/** Per-agent queues for follow-up messages (drained by hookProviders). */
	readonly #followUpQueues = new Map<string, AgentMessage[]>();

	constructor(options: AgentRuntimeOptions) {
		this.#roleProvider = options.roleProvider;
		this.#contextPipeline = options.contextPipeline;
		this.#launcher = options.launcher;
		this.#ircBus = options.ircBus;
		this.#hookPipeline = options.hookPipeline;
		this.#modelRegistry = options.modelRegistry;
		this.#settings = options.settings;
		this.#activityLogger = options.activityLogger;
		this.#toolRegistry = options.toolRegistry;
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
	 * Spawn agents for a structured roundtable discussion.
	 *
	 * Each spec becomes a participant. The roundtable runs for the
	 * configured number of rounds, with optional convergence-based
	 * early exit.
	 *
	 * Flow per round:
	 * 1. Build each agent's task with prior round positions appended
	 * 2. Spawn all agents in parallel via spawn()
	 * 3. Collect responses
	 * 4. Check convergence (Jaccard similarity of token sets)
	 * 5. If converged for N consecutive rounds, exit early
	 */
	async spawnRoundtable(specs: AgentSpec[], config: RoundtableConfig): Promise<RoundtableResult> {
		const allResponses: string[] = [];
		let lastRoundPositions: string[] = [];
		let prevRoundPositions: string[] = [];
		let convergenceStreak = 0;
		const convergenceThreshold = config.convergenceThreshold ?? 0.8;
		const convergenceStreakRequired = config.convergenceStreak ?? 1;

		for (let round = 0; round < config.rounds; round++) {
			// Build per-agent tasks with prior round context
			const priorContext =
				prevRoundPositions.length > 0
					? "\n\n## Prior Round Positions\n" +
						prevRoundPositions.map((p, j) => `**Agent ${specs[j]?.id ?? j}:** ${p}`).join("\n\n") +
						"\n\nReview the above positions. Provide your updated position."
					: "";

			const roundSpecs = specs.map(s => ({
				...s,
				task: s.task + priorContext,
			}));

			// Spawn all agents in parallel
			const handles = await this.spawn(roundSpecs);

			// Wait for all responses with optional per-round timeout
			const results = await Promise.allSettled(handles.map(h => h.wait(config.timeoutMs ?? 300_000)));

			const roundResponses = results.map((r, i) => {
				if (r.status === "fulfilled") {
					const out = r.value;
					return out?.output ?? out ?? "(no response)";
				}
				logger.warn("[AgentRuntime] Roundtable agent failed", {
					round,
					agentId: specs[i]?.id,
					error: String(r.reason),
				});
				return "(no response)";
			});

			allResponses.push(...roundResponses);
			lastRoundPositions = roundResponses;

			// Check convergence (skip first round — nothing to compare against)
			if (round > 0 && prevRoundPositions.length === roundResponses.length) {
				const similarity = jaccardSimilarity(roundResponses.join(" "), prevRoundPositions.join(" "));

				if (similarity >= convergenceThreshold) {
					convergenceStreak++;
					if (convergenceStreak >= convergenceStreakRequired) {
						logger.info("[AgentRuntime] Roundtable converged", {
							round: round + 1,
							similarity,
							streak: convergenceStreak,
						});
						return {
							converged: true,
							rounds: round + 1,
							responses: allResponses,
							finalPositions: lastRoundPositions,
						};
					}
				} else {
					convergenceStreak = 0;
				}
			}

			prevRoundPositions = [...lastRoundPositions];
		}

		logger.info("[AgentRuntime] Roundtable completed without convergence", {
			rounds: config.rounds,
		});

		return {
			converged: false,
			rounds: config.rounds,
			responses: allResponses,
			finalPositions: lastRoundPositions,
		};
	}

	/**
	 * Queue a human steering message for a specific agent.
	 *
	 * The message is logged via IrcBus.receiveFromHuman(). Actual delivery
	 * to the agent is handled by PhaseBehaviors via handle.send().
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
		// Also deliver via IrcBus for real-time IRC routing
		await this.#ircBus.receiveFromHuman(text, agentId);
	}

	/**
	 * Queue a system notification (aside message) for a specific agent.
	 */
	async sendSystemNotification(agentId: string, text: string): Promise<void> {
		const queue = this.#asideQueues.get(agentId) ?? [];
		queue.push({
			role: "user",
			content: [{ type: "text", text: `[System] ${text}` }],
			timestamp: Date.now(),
		});
		this.#asideQueues.set(agentId, queue);
	}

	/** The communication bus for human steering and agent messaging. */
	get ircBus(): IrcBus {
		return this.#ircBus;
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
	 * 4. Build AgentLoopConfig hooks from IrcBus queues
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

		// 4. Build AgentLoopConfig hook providers from internal queues
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
