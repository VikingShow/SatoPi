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
import type {
  ModelRegistry,
  Settings,
} from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";

import type { AgentSpec } from "./agent-spec";
import type { ResolvedRole } from "./role-provider";
import { RoleProvider } from "./role-provider";
import type { LaunchContext } from "./agent-launcher";
import { AgentLauncher } from "./agent-launcher";
import { AgentHandle } from "./agent-handle";

import type { ContextPipeline, AssembledContext, PhaseInfo } from "../context-manager/context-pipeline";
import type { CommBus } from "../comm-bus/comm-bus";
import type { HookPipeline } from "../hook-system/hook-pipeline";
import type { ActivityLogger } from "../hooks/activity-logger";
import { AgentRegistry } from "../../registry/agent-registry";

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
  commBus: CommBus;

  /** Hook pipeline for lifecycle events. */
  hookPipeline: HookPipeline;

  /** Model registry (needed for LaunchContext modelRegistry). */
  modelRegistry: ModelRegistry;

  /** Settings (needed for LaunchContext settings). */
  settings: Settings;

  /** Optional activity logger for streaming output. */
  activityLogger?: ActivityLogger;
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
 *   roleProvider, contextPipeline, launcher, commBus, hookPipeline,
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
  readonly #commBus: CommBus;
  readonly #hookPipeline: HookPipeline;
  readonly #modelRegistry: ModelRegistry;
  readonly #settings: Settings;
  readonly #activityLogger?: ActivityLogger;

  /** Per-agent message queues for steering messages (populated from CommBus). */
  readonly #steeringQueues = new Map<string, AgentMessage[]>();

  /** Per-agent message queues for follow-up messages. */
  readonly #followUpQueues = new Map<string, AgentMessage[]>();

  /** Per-agent queues for system notification (aside) messages. */
  readonly #asideQueues = new Map<string, AsideMessage[]>();

  constructor(options: AgentRuntimeOptions) {
    this.#roleProvider = options.roleProvider;
    this.#contextPipeline = options.contextPipeline;
    this.#launcher = options.launcher;
    this.#commBus = options.commBus;
    this.#hookPipeline = options.hookPipeline;
    this.#modelRegistry = options.modelRegistry;
    this.#settings = options.settings;
    this.#activityLogger = options.activityLogger;
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
   * @returns AgentHandle[] — each handle provides wait(), send(), abort(), outputStream()
   */
  async spawn(specs: AgentSpec[]): Promise<AgentHandle[]> {
    const handles = await Promise.all(specs.map((spec) => this.spawnOne(spec)));
    return handles;
  }

  /**
   * Spawn agents for a structured roundtable discussion.
   *
   * Each spec becomes a participant. The roundtable runs for the
   * configured number of rounds, with optional convergence-based
   * early exit.
   */
  async spawnRoundtable(
    _specs: AgentSpec[],
    _config: RoundtableConfig,
  ): Promise<RoundtableResult> {
    // Roundtable orchestration will be implemented in a later phase.
    // For now, return a stub result.
    logger.warn(
      "[AgentRuntime] spawnRoundtable() not yet implemented — returning stub",
    );
    return {
      converged: false,
      rounds: 0,
      responses: [],
      finalPositions: [],
    };
  }

  /**
   * Queue a human steering message for a specific agent.
   *
   * The message will be delivered to the agent at the next injection boundary.
   * Uses CommBus.receiveFromHuman() to log the message, then queues it
   * for delivery to the target agent's steering queue.
   */
  async sendHumanMessage(agentId: string, text: string): Promise<void> {
    // Log via CommBus
    await this.#commBus.receiveFromHuman(text, agentId);

    // Queue for agent delivery
    const queue = this.#steeringQueues.get(agentId) ?? [];
    queue.push({
      role: "user",
      content: [{ type: "text", text: `[Human] ${text}` }],
      timestamp: Date.now(),
    });
    this.#steeringQueues.set(agentId, queue);
  }

  /**
   * Queue a system notification (aside message) for a specific agent.
   */
  async sendSystemNotification(
    agentId: string,
    text: string,
  ): Promise<void> {
    const queue = this.#asideQueues.get(agentId) ?? [];
    queue.push({
      role: "user",
      content: [{ type: "text", text: `[System] ${text}` }],
      timestamp: Date.now(),
    });
    this.#asideQueues.set(agentId, queue);
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
   * 4. Build AgentLoopConfig hooks from CommBus queues
   * 5. AgentLauncher.launch(launchContext)
   * 6. HookPipeline.trigger("agent:afterSpawn")
   */
  private async spawnOne(spec: AgentSpec): Promise<AgentHandle> {
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
    const phaseInfo: PhaseInfo = {
      phase: "stage",
      multiAgent: true,
      humanMode: "observer",
    };

    const baseContext = {
      taskDescription: spec.task,
      workspace: process.cwd(),
      swarmDir: ".swarm-workspace",
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
      getAsideMessages: async () => {
        const queue = this.#asideQueues.get(agentId);
        if (!queue || queue.length === 0) return [];
        const messages = queue.splice(0);
        this.#asideQueues.delete(agentId);
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
    };

    let handle: AgentHandle;
    try {
      handle = await this.#launcher.launch(launchContext);
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
      { agentId, role: spec.role, handle },
      { agentId, phase: "stage" },
    );

    // 6.5 Wire lifecycle callbacks for persistent agents
    if (spec.profileId) {
      handle.onComplete = () => {
        AgentRegistry.global().setStatus(spec.id, "idle");
      };
      handle.onError = () => {
        AgentRegistry.global().setStatus(spec.id, "aborted");
      };
    }

    return handle;
  }
}
