/**
 * agent-launcher.ts — Creates SatoPi AgentSessions via createAgentSession().
 *
 * KEY DESIGN: Uses createAgentSession() (the same API as sdk.ts) instead of
 * directly constructing Agent instances. This gives us yield/skills/MCP/IRC/
 * streaming for free, with MMD and L3 compaction handled by the SDK's internal
 * transformContext.
 *
 * The AgentLauncher resolves the model, builds the system prompt, resolves tool
 * names from the role + ContextPipeline, and passes everything to
 * createAgentSession(). Steering/follow-up messages from the CommBus are wired
 * through the session before the agent loop starts.
 *
 * Part of the AgentRuntime system (Phase 3A of the swarm v3 unified architecture).
 */

import type { AgentMessage, AsideMessage } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import type { IOffloadManager } from "../../offload/manager";
import type { MmdInjector } from "../../offload/mermaid/injector";
import { createAgentSession } from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import type { Tool, ToolSession } from "../../tools";
import type { AssembledContext, ContextPipeline } from "../context-manager/context-pipeline";
import type { ActivityLogger } from "../infra/activity-logger";
import type { AgentSpec } from "./agent-spec";
import type { ResolvedRole, RoleProvider } from "../../agent/role-provider";
import type { AgentRuntime } from "./index";

// ============================================================================
// Types
// ============================================================================

/**
 * Full launch context assembled by AgentRuntime before passing to AgentLauncher.
 */
export interface LaunchContext {
	/** The original agent spec. */
	spec: AgentSpec;

	/** Resolved role (system prompt, tools). */
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

	/**
	 * Optional AgentRuntime reference injected by the runtime.
	 * When set, the launcher wires it into the spawned session's tool context
	 * so tools like `agent_invoke` can spawn and steer persistent agents.
	 */
	agentRuntime?: AgentRuntime;
	/**
	 * Optional ContextPipeline reference for building transformContext.
	 * When provided, the launcher calls pipeline.toTransformContext(assembledContext)
	 * and passes the result to createAgentSession() as transformContext,
	 * so ContextPipeline's injected-message prepend + L3 compact flow
	 * merges with the SDK's extension-emit / steering-wrap pipeline.
	 */
	pipeline?: ContextPipeline;
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
 * Creates and starts SatoPi AgentSessions with full hook wiring.
 *
 * The launcher is responsible for:
 * 1. Model resolution (spec.modelPreference)
 * 2. System prompt assembly
 * 3. AgentSession creation via createAgentSession() with all hooks
 * 4. Agent lifecycle start (session.prompt)
 * 5. Returning an AgentSession
 */
export class AgentLauncher {
	#modelRegistry: ModelRegistry;
	#settings: Settings;
	/** Override for testing — defaults to createAgentSession. */
	#sessionFactory: typeof createAgentSession;

	constructor(modelRegistry: ModelRegistry, settings: Settings, sessionFactory?: typeof createAgentSession) {
		this.#modelRegistry = modelRegistry;
		this.#settings = settings;
		this.#sessionFactory = sessionFactory ?? createAgentSession;
	}

	/**
	 * Create and launch a single agent, returning an AgentSession.
	 *
	 * Uses createAgentSession() instead of new Agent():
	 *   1. Resolves the model
	 *   2. Builds a system prompt from assembledContext + resolvedRole
	 *   3. Creates an AgentSession via createAgentSession() with all hooks wired
	 *   4. Starts the agent via session.prompt(spec.task)
	 *   5. Returns the AgentSession directly
	 */
	async launch(ctx: LaunchContext): Promise<AgentSession> {
		const { spec, resolvedRole, assembledContext, hookProviders } = ctx;

		// 1. Resolve model
		const model = this.#resolveModel(spec, resolvedRole);
		if (!model) {
			throw new Error(`[AgentLauncher] No available model for agent "${spec.id}"`);
		}

		// 2. Build system prompt
		const systemPrompt = this.#buildSystemPrompt(spec, resolvedRole, assembledContext);

		// 3. Resolve tool names for selection
		const toolNames = this.#resolveTools(resolvedRole, assembledContext);

		// 3.5 Build transformContext from ContextPipeline (SP-7: pipeline-driven context)
		const transformCtx = ctx.pipeline?.toTransformContext(assembledContext, {
			compactWindow: ctx.contextWindow,
		});

		const { session } = await this.#sessionFactory({
			// 4. Create AgentSession (replaces new Agent — gets yield/skills/MCP/IRC/streaming for free)
			model,
			systemPrompt: [systemPrompt],
			toolNames,
			modelRegistry: this.#modelRegistry,
			agentId: spec.id,
			agentDisplayName: spec.id,
			settings: this.#settings,
			// ContextPipeline-driven transform: prepend injectedMessages + L3 compact
			// (merged with SDK's extension-emit / steering-wrap pipeline)
			transformContext: transformCtx,
			// Future: MMD per-turn injection
			mmdInjector: ctx.mmdInjector,
			activeMmd: ctx.activeMmd,
			// Minimal discovery for swarm sub-agents
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			hasUI: false,
			autoApprove: true,
			hasIrcInterrupts: true,
			getSteeringMessages: hookProviders.getSteeringMessages,
			getFollowUpMessages: hookProviders.getFollowUpMessages,
		});

		// 4.5 Wire AgentRuntime into the session's tool context so tools like
		//     agent_invoke can spawn and steer persistent agents.
		if (ctx.agentRuntime) {
			session.setToolContextAgentRuntime(ctx.agentRuntime);
		}

		// 5. Wire aside message provider (system notifications from CommBus)
		if (hookProviders.getAsideMessages) {
			session.agent.setAsideMessageProvider(hookProviders.getAsideMessages);
		}

		// 6. Set agent identity on the session for swarm tracking
		session.role = spec.role;

		// 7. Launch the agent asynchronously
		//    Use fire-and-forget: the session's wait() method lets callers
		//    await completion when they need results.
		this.#startAgent(session, spec).catch(err => {
			logger.warn("[AgentLauncher] Unhandled startAgent error", {
				agentId: spec.id,
				error: err instanceof Error ? err.message : String(err),
			});
		});

		logger.debug("[AgentLauncher] Agent launched", {
			id: spec.id,
			role: spec.role,
			modelId: model.id,
		});

		return session;
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
	#resolveModel(spec: AgentSpec, _role: ResolvedRole): Model | undefined {
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
	#buildSystemPrompt(_spec: AgentSpec, resolvedRole: ResolvedRole, assembledContext: AssembledContext): string {
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
	#resolveTools(resolvedRole: ResolvedRole, assembledContext: AssembledContext): string[] {
		const toolSet = new Set<string>();

		for (const t of resolvedRole.tools) toolSet.add(t);
		for (const t of assembledContext.tools) toolSet.add(t);

		return [...toolSet];
	}

	/**
	 * Start the SatoPi agent loop.
	 *
	 * Steering and follow-up messages are wired through the AgentLoopConfig
	 * hooks (getSteeringMessages / getFollowUpMessages) passed to the Agent
	 * during session creation. The AgentLoopConfig drains both the external
	 * CommBus-based providers and the Agent's own internal queues at each
	 * injection boundary — no separate polling loop needed.
	 */
	async #startAgent(session: AgentSession, spec: AgentSpec): Promise<void> {
		try {
			await session.prompt(spec.task);
		} catch (err) {
			logger.warn("[AgentLauncher] Agent prompt threw", {
				agentId: spec.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
