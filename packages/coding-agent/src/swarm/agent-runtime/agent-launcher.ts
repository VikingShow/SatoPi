/**
 * agent-launcher.ts — Creates SatoPi Agent instances with full AgentLoopConfig wiring.
 *
 * KEY DESIGN: Does NOT use runSubprocess(). Instead directly creates
 * Agent instances using the SatoPi public API (same approach as sdk.ts).
 * This enables access to ALL AgentLoopConfig hooks:
 *   - transformContext (ContextPipeline injection)
 *   - getSteeringMessages (Human steering from CommBus)
 *   - getAsideMessages (system notifications)
 *   - getFollowUpMessages (multi-turn dialogue)
 *
 * When a `toolRegistry` is provided via LaunchContext, real tools are resolved
 * by name. Without one, mock stubs are used with an error-level log (P0-3 fix).
 *
 * Part of the AgentRuntime system (Phase 3A of the swarm v3 unified architecture).
 */

import { Agent } from "@oh-my-pi/pi-agent-core";
import type {
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AsideMessage,
} from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type {
  ModelRegistry,
  Settings,
  SingleResult,
} from "@oh-my-pi/pi-coding-agent";
import type { Tool, ToolSession } from "../../tools";
import { createTools } from "../../tools";
import { logger } from "@oh-my-pi/pi-utils";
import type { ActivityLogger } from "../hooks/activity-logger";
import type { AssembledContext } from "../context-manager/context-pipeline";

import { compactContext, DEFAULT_COMPACT_CONFIG } from "../../offload/compact";
import type { MmdInjector } from "../../offload/mermaid/injector";
import type { IOffloadManager } from "../../offload/manager";
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

  /** Offload manager for L3 compact context summaries. */
  offloadManager?: IOffloadManager;
  /** MMD injector for per-turn Mermaid injection. */
  mmdInjector?: MmdInjector;
  /** Active MMD content (from OffloadManager). */
  activeMmd?: string;
  /** Context window for compaction threshold (in tokens). */
  contextWindow?: number;

  /**
   * Optional pre-built SatoPi tool registry (Map name → Tool).
   * When provided, real tools are resolved by name instead of using mock stubs.
   * Without this, tools execute as no-op mocks (P0-3 — will log an error).
   */
  toolRegistry?: Map<string, Tool>;

  /**
   * Optional built-in tool names for createTools()-based tool creation (Phase A1).
   * When provided, real tools are created via {@link createTools} with a minimal
   * ToolSession assembled from {@link createToolSession} callback + launcher defaults.
   * This is the preferred path for SatoPi swarm agents — it uses the same
   * BUILTIN_TOOLS factory pipeline as the main agent session.
   */
  builtinToolNames?: string[];

  /**
   * Optional callback to produce a partial ToolSession for createTools().
   * Fields not provided are filled with defaults from the launcher
   * (cwd, settings, modelRegistry, etc.).
   * Only consulted when {@link builtinToolNames} is also provided.
   */
  createToolSession?: () => Partial<ToolSession>;
}

/**
 * Minimal ToolSession for SatoPi swarm agents (Phase B1).
 *
 * Documents the required ToolSession fields that the AgentLauncher
 * always provides when constructing a session for {@link createTools}.
 * Callers may supply additional ToolSession fields via the optional
 * `LaunchContext.createToolSession` callback.
 */
export interface MinimalToolSession extends Partial<ToolSession> {
  cwd: string;
  settings: Settings;
  modelRegistry: ModelRegistry;
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

    // 3. Resolve tools — prefer createTools (A1), then registry, then mock stubs
    const toolNames = this.#resolveTools(resolvedRole, assembledContext);
    const tools = await this.#resolveToolInstances(
      toolNames,
      ctx.builtinToolNames,
      ctx.createToolSession,
      ctx.toolRegistry,
    );

    // 4. Create Agent instance (SatoPi public API)
    const agent = new Agent({
      initialState: {
        systemPrompt: [systemPrompt],
        model,
        tools,
      },
      // ContextPipeline injection via transformContext
      transformContext: async (messages: AgentMessage[], signal?: AbortSignal) => {
        // Step 1: Inject external context (existing)
        const injected = assembledContext.injectedMessages as AgentMessage[];
        let result = injected.length > 0 ? [...injected, ...messages] : messages;

        // Step 2: Inject MMD per-turn (Phase 5)
        if (ctx.mmdInjector && ctx.activeMmd && result.length > 0) {
          try {
            const userIdx = result.findIndex(m => m.role === "user");
            if (userIdx >= 0) {
              const mmdMsg: AgentMessage = {
                role: "user",
                content: [{ type: "text", text: ctx.activeMmd }],
                timestamp: Date.now(),
              } as AgentMessage;
              result.splice(userIdx + 1, 0, mmdMsg);
            }
          } catch (err) {
            logger.debug("[AgentLauncher] MMD injection skipped", { error: String(err) });
          }
        }

        // Step 3: Apply L3 compact context (fusion with oh-my-pi compaction)
        if (ctx.offloadManager && ctx.contextWindow) {
          try {
            const compacted = compactContext(result, new Map(), {
              ...DEFAULT_COMPACT_CONFIG,
              contextWindow: ctx.contextWindow,
            });
            result = compacted.messages;
          } catch (err) {
            logger.debug("[AgentLauncher] Compact context skipped", { error: String(err) });
          }
        }

        return result;
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
    // Session wiring: pass null — the caller (AgentRuntime.spawnOne) handles
    // AgentRegistry registration separately once a real session is available.
    const handle = new AgentHandle(spec.id, spec.role, agent, null);

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
      // No reliable pricing field — return first available as cheapest heuristic
      return available[0];
    }

    if (spec.modelPreference === "smartest") {
      // Heuristic: larger context window implies smarter model
      return (
        available
          .slice()
          .sort(
            (a, b) =>
              (typeof b.contextWindow === "number" ? b.contextWindow : 0) -
              (typeof a.contextWindow === "number" ? a.contextWindow : 0),
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
   * Resolve tool instances using the most-capable available path.
   *
   * Resolution order (first match wins):
   * 1. **createTools()** (Phase A1) — when `builtinToolNames` is provided,
   *    real tools are created via the SatoPi BUILTIN_TOOLS factory pipeline
   *    with a minimal ToolSession assembled from the callback + launcher defaults.
   * 2. **ToolRegistry lookup** — when `toolRegistry` is provided, tools are
   *    looked up by name in the pre-built map.
   * 3. **Mock stubs** (@deprecated) — fallback no-op tools; logs an error.
   */
  async #resolveToolInstances(
    toolNames: string[],
    builtinToolNames?: string[],
    createToolSession?: () => Partial<ToolSession>,
    toolRegistry?: Map<string, Tool>,
  ): Promise<AgentTool<any, any, unknown>[]> {
    // ── Path A: createTools()-based real tool creation (Phase A1) ──────────
    if (builtinToolNames && builtinToolNames.length > 0) {
      const partial = createToolSession?.() ?? {};
      const session = {
        ...partial,
        // Launcher-provided fields — always take precedence
        settings: this.#settings,
        modelRegistry: this.#modelRegistry,
        // Required ToolSession fields filled from partial or defaults
        cwd: partial.cwd ?? process.cwd(),
        hasUI: partial.hasUI ?? false,
        getSessionFile: partial.getSessionFile ?? (() => null),
        getSessionSpawns: partial.getSessionSpawns ?? (() => null),
      } satisfies MinimalToolSession;

      const tools = await createTools(session, builtinToolNames);
      logger.debug("[AgentLauncher] Resolved tools via createTools()", {
        requested: builtinToolNames.length,
        resolved: tools.length,
        names: tools.map((t) => t.name),
      });
      return tools as unknown as AgentTool<any, any, unknown>[];
    }

    // ── Path B: Real tool registry available — resolve by name ────────────
    if (toolRegistry && toolRegistry.size > 0) {
      const resolved: AgentTool<any, any, unknown>[] = [];
      for (const name of toolNames) {
        const tool = toolRegistry.get(name);
        if (tool) {
          resolved.push(tool as AgentTool<any, any, unknown>);
        } else {
          logger.warn("[AgentLauncher] Tool not found in registry, skipping", { tool: name });
        }
      }
      logger.debug("[AgentLauncher] Resolved tools from registry", {
        requested: toolNames.length,
        resolved: resolved.length,
      });
      return resolved;
    }

    // ── Path C: No tool registry — mock stubs (@deprecated since Phase A1) ─
    // TODO: Remove once all callers provide builtinToolNames + createToolSession
    // or a toolRegistry via LaunchContext (Phase A4).
    logger.error(
      "[AgentLauncher] No builtinToolNames or toolRegistry provided — " +
      "ALL tools are mock stubs! Callers should pass builtinToolNames + " +
      "createToolSession (Phase A1) or a toolRegistry via LaunchContext. " +
      `Agent has ${toolNames.length} tool(s) that will execute as no-ops.`,
    );
    /** @deprecated Remove mock-stub fallback once all callers use createTools path (Phase A4). */
    return toolNames.map((name) => ({
      name,
      description: `Tool: ${name} (MOCK — no builtinToolNames or toolRegistry provided)`,
      parameters: {
        type: "object" as const,
        properties: {} as Record<string, unknown>,
        additionalProperties: true,
      },
      execute: async () => ({
        content: [{ type: "text" as const, text: `Tool ${name} executed (mock — no builtinToolNames or toolRegistry)` }],
      }),
    })) as unknown as AgentTool<any, any, unknown>[];
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
