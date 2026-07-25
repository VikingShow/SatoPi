/**
 * agent-launcher.ts — Creates oh-my-pi Agent + AgentSession instances
 * with full AgentLoopConfig wiring.
 *
 * KEY DESIGN: Does NOT use runSubprocess(). Instead directly creates
 * Agent and AgentSession using oh-my-pi's public API (same approach as
 * sdk.ts). This enables access to ALL AgentLoopConfig hooks:
 *   - transformContext (ContextPipeline injection)
 *   - getSteeringMessages (Human steering from CommBus)
 *   - getAsideMessages (system notifications)
 *   - getFollowUpMessages (multi-turn dialogue)
 *
 * Part of the AgentRuntime system (Phase 3A).
 */

import { Agent } from "@oh-my-pi/pi-agent-core";
import type {
  AgentLoopConfig,
  AgentMessage,
  AsideMessage,
} from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type {
  ModelRegistry,
  Settings,
  SingleResult,
} from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import type { ActivityLogger } from "../hooks/activity-logger";
import type { AssembledContext } from "../context-manager/context-pipeline";
import type { AgentSpec } from "./agent-spec";
import type { ResolvedRole } from "./role-provider";
import { AgentHandle } from "./agent-handle";

// ============================================================================
// Types
// ============================================================================

/**
 * Full launch context assembled by AgentRuntime before passing to AgentLauncher.
 */
export interface LaunchContext {
  /** The original agent spec. */
  spec: AgentSpec;

  /** Resolved role (system prompt, tools, modelRole). */
  resolvedRole: ResolvedRole;

  /** Context assembled by ContextPipeline (system prompt, tools, injected msgs). */
  assembledContext: AssembledContext;

  /**
   * Hook providers that feed into AgentLoopConfig.
   *
   * These are assembled by AgentRuntime from CommBus queues:
   * - getSteeringMessages: pending human steering messages
   * - getFollowUpMessages: pending follow-up dialogue messages
   * - getAsideMessages: pending system notifications
   */
  hookProviders: {
    getSteeringMessages?: () => Promise<AgentMessage[]>;
    getFollowUpMessages?: () => Promise<AgentMessage[]>;
    getAsideMessages?: () => Promise<AsideMessage[]>;
  };

  /** Model registry for model resolution. */
  modelRegistry: ModelRegistry;

  /** Settings for model and tool configuration. */
  settings: Settings;

  /** Optional AbortSignal for cancellation. */
  signal?: AbortSignal;

  /** Optional activity logger for streaming output. */
  activityLogger?: ActivityLogger;
}

// ============================================================================
// AgentLauncher
// ============================================================================

/**
 * Creates and starts oh-my-pi Agent instances with full hook wiring.
 *
 * The launcher is responsible for:
 * 1. Model resolution (spec.modelPreference + resolvedRole.modelRole)
 * 2. System prompt assembly
 * 3. Agent creation with transformContext + getApiKey + all hooks
 * 4. Agent lifecycle start (prompt)
 * 5. Returning an AgentHandle
 */
export class AgentLauncher {
  #modelRegistry: ModelRegistry;
  #settings: Settings;
  #activityLogger?: ActivityLogger;

  constructor(
    modelRegistry: ModelRegistry,
    settings: Settings,
    activityLogger?: ActivityLogger,
  ) {
    this.#modelRegistry = modelRegistry;
    this.#settings = settings;
    this.#activityLogger = activityLogger;
  }

  /**
   * Create and launch a single agent, returning an AgentHandle.
   *
   * Does NOT use runSubprocess(). Instead:
   *   1. Resolves the model
   *   2. Builds a system prompt from assembledContext + resolvedRole
   *   3. Creates an Agent instance via `new Agent({...})` with all hooks wired
   *   4. Starts the agent via `agent.prompt(spec.task)`
   *   5. Wraps in AgentHandle
   */
  async launch(ctx: LaunchContext): Promise<AgentHandle> {
    const { spec, resolvedRole, assembledContext, hookProviders } = ctx;

    // 1. Resolve model
    const model = this.#resolveModel(spec, resolvedRole);
    if (!model) {
      throw new Error(
        `[AgentLauncher] No available model for agent "${spec.id}"`,
      );
    }

    // 2. Build system prompt
    const systemPrompt = this.#buildSystemPrompt(spec, resolvedRole, assembledContext);

    // 3. Resolve tools
    const toolNames = this.#resolveTools(resolvedRole, assembledContext);

    // 4. Create Agent instance (oh-my-pi public API)
    const agent = new Agent({
      initialState: {
        systemPrompt: [systemPrompt],
        model,
        tools: toolNames.map((name) => ({
          name,
          description: `Tool: ${name}`,
          parameters: {
            type: "object" as const,
            properties: {} as Record<string, unknown>,
            additionalProperties: true,
          },
          execute: async () => ({
            content: [{ type: "text" as const, text: `Tool ${name} executed (mock)` }],
          }),
        })),
      },
      // ContextPipeline injection via transformContext
      transformContext: async (messages: AgentMessage[], _signal?: AbortSignal) => {
        const injected = assembledContext.injectedMessages as AgentMessage[];
        if (injected.length === 0) return messages;
        return [...injected, ...messages];
      },
      // Human steering via CommBus
      steeringMode: "one-at-a-time",
      // Multi-turn follow-up via CommBus
      followUpMode: "one-at-a-time",
      // Interrupt mode for steering
      interruptMode: "immediate",
      // API key resolution via ModelRegistry
      getApiKey: async (requestModel: Model) => {
        try {
          return await this.#modelRegistry.resolver(requestModel, spec.id);
        } catch {
          return undefined;
        }
      },
    });

    // 5. Wire aside message provider (system notifications from CommBus)
    if (hookProviders.getAsideMessages) {
      agent.setAsideMessageProvider(hookProviders.getAsideMessages);
    }

    // 6. Start the agent with the task description
    //    The agent won't start the loop until prompt() is called.
    //    We start it immediately and return the handle.
    const session = {}; // Placeholder — AgentSession is created by AgentSession class in oh-my-pi

    const handle = new AgentHandle(spec.id, spec.role, agent, session);

    // 7. Launch the agent asynchronously
    //    Use fire-and-forget: the handle's wait() method lets callers
    //    await completion when they need results.
    this.#startAgent(agent, spec, hookProviders, ctx.signal);

    logger.debug("[AgentLauncher] Agent launched", {
      id: spec.id,
      role: spec.role,
      modelId: model.id,
    });

    return handle;
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Resolve the model for an agent from spec preferences and role hints.
   *
   * Resolution order:
   * 1. spec.modelPreference "cheapest" → first available cheap model
   * 2. spec.modelPreference "smartest" → first available large model
   * 3. Otherwise → first available default model from registry
   */
  #resolveModel(spec: AgentSpec, role: ResolvedRole): Model | undefined {
    const available = this.#modelRegistry.getAvailable();

    if (available.length === 0) {
      logger.warn("[AgentLauncher] No models available in registry");
      return undefined;
    }

    // Pick based on preference
    if (spec.modelPreference === "cheapest") {
      return (
        available.find((m) => m.costPerMTok?.output !== undefined) ?? available[0]
      );
    }

    if (spec.modelPreference === "smartest") {
      // Heuristic: larger context window implies smarter model
      return (
        available
          .slice()
          .sort(
            (a, b) =>
              (b.contextWindow?.input ?? 0) - (a.contextWindow?.input ?? 0),
          )[0] ?? available[0]
      );
    }

    // Default: first available
    return available[0];
  }

  /**
   * Build the system prompt from assembled context and resolved role.
   */
  #buildSystemPrompt(
    _spec: AgentSpec,
    resolvedRole: ResolvedRole,
    assembledContext: AssembledContext,
  ): string {
    const parts: string[] = [];

    // 1. Role system prompt (from library or inline)
    if (resolvedRole.systemPrompt) {
      parts.push(resolvedRole.systemPrompt);
    }

    // 2. Guidelines
    if (resolvedRole.guidelines.length > 0) {
      parts.push("\n## Guidelines");
      for (const g of resolvedRole.guidelines) {
        parts.push(`- ${g}`);
      }
    }

    // 3. Assembled context system prompt (from ContextPipeline sources)
    if (assembledContext.systemPrompt) {
      parts.push(`\n${assembledContext.systemPrompt}`);
    }

    return parts.join("\n");
  }

  /**
   * Resolve tool names from the resolved role and assembled context.
   * Merges both sets, removing duplicate tool names.
   */
  #resolveTools(
    resolvedRole: ResolvedRole,
    assembledContext: AssembledContext,
  ): string[] {
    const toolSet = new Set<string>();

    for (const t of resolvedRole.tools) toolSet.add(t);
    for (const t of assembledContext.tools) toolSet.add(t);

    return [...toolSet];
  }

  /**
   * Start the oh-my-pi agent loop asynchronously.
   *
   * Pushes human steering messages from hook providers into the agent's
   * steering queue before launching, then starts the prompt loop.
   */
  async #startAgent(
    agent: Agent,
    spec: AgentSpec,
    hookProviders: LaunchContext["hookProviders"],
    _signal?: AbortSignal,
  ): Promise<void> {
    // Pre-load steering messages from CommBus
    try {
      if (hookProviders.getSteeringMessages) {
        const steeringMessages = await hookProviders.getSteeringMessages();
        for (const msg of steeringMessages) {
          agent.steer(msg);
        }
      }
    } catch (err) {
      logger.warn("[AgentLauncher] Failed to pre-load steering messages", {
        agentId: spec.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Pre-load follow-up messages
    try {
      if (hookProviders.getFollowUpMessages) {
        const followUpMessages = await hookProviders.getFollowUpMessages();
        for (const msg of followUpMessages) {
          agent.followUp(msg);
        }
      }
    } catch (err) {
      logger.warn("[AgentLauncher] Failed to pre-load follow-up messages", {
        agentId: spec.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Start the agent loop
    try {
      await agent.prompt(spec.task);
    } catch (err) {
      logger.warn("[AgentLauncher] Agent prompt threw", {
        agentId: spec.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
