/**
 * spawnAgent — Pure function replacement for AgentRuntime.spawn().
 *
 * Takes an AgentSpec and infrastructure services, returns a running AgentSession.
 * No class, no state — all coordination is explicit through parameters.
 *
 * Replaces AgentRuntime.#spawnOne() (Phase 5 refactoring).
 */

import type { ModelRegistry, Settings } from "@satopi/pi-coding-agent";
import { logger } from "@satopi/pi-utils";
import type { ResolvedRole, RoleProvider } from "../agent/role-provider";
import type { CommChannel } from "../comm/comm-channel";
import type { ContextPipeline, PhaseInfo } from "../context/context-pipeline";
import type { HookPipeline } from "../hooks/hook-pipeline";
import type { SwarmModeController } from "../modes/controllers/swarm-mode-controller";
import { AgentRegistry } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { AgentSpec } from "./agent-spec";

// ============================================================================
// Types
// ============================================================================

export interface SpawnAgentOptions {
	/** Agent specification. */
	spec: AgentSpec;
	/** Role provider for resolving spec.role → system prompt + tools. */
	roleProvider: RoleProvider;
	/** Context pipeline for assembling per-agent context. */
	contextPipeline: ContextPipeline;
	/** Hook pipeline for lifecycle events. */
	hookPipeline: HookPipeline;
	/** Model registry for API key resolution. */
	modelRegistry: ModelRegistry;
	/** Application settings. */
	settings: Settings;
	/** Optional CommChannel for crew-based communication. */
	commChannel?: CommChannel;
	/** Optional SwarmModeController for Crew-based agent response capture. */
	swarmModeController?: SwarmModeController;
	/** Optional external steering queue — when set, spawnAgent pushes here instead of a local queue. */
	steeringQueue?: Array<{ role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }>;
	/** Optional external aside queue — when set, spawnAgent pushes here instead of a local queue. */
	asideQueue?: Array<{ role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }>;
	/** Current phase for context filtering. */
	phase?: string;
	/** Optional session factory override for testing. */
	sessionFactory?: typeof createAgentSession;
}

// ============================================================================
// spawnAgent
// ============================================================================

/**
 * Spawn a single agent from its spec. Returns the running AgentSession.
 *
 * Lifecycle:
 * 1. HookPipeline.trigger("agent:beforeSpawn")
 * 2. RoleProvider.resolve(spec)
 * 3. ContextPipeline.assemble(spec, phase)
 * 4. Resolve model, build system prompt, resolve tools
 * 5. createAgentSession({ agentKind: "main", profileId: spec.profileId, ... })
 * 6. Register in AgentRegistry.global()
 * 7. Wire aside message provider
 * 8. HookPipeline.trigger("agent:afterSpawn")
 * 9. session.prompt(spec.task) — blocks until completion
 */
export async function spawnAgent(opts: SpawnAgentOptions): Promise<AgentSession> {
	const {
		spec,
		roleProvider,
		contextPipeline,
		hookPipeline,
		modelRegistry,
		settings,
		commChannel,
		swarmModeController,
		phase,
		sessionFactory,
		steeringQueue: extSteeringQueue,
		asideQueue: extAsideQueue,
	} = opts;
	const agentId = spec.id;

	// 1. Before-spawn hook
	await hookPipeline.trigger(
		"agent:beforeSpawn",
		{ agentId, role: spec.role, task: spec.task },
		{ agentId, phase: phase ?? "idle" },
	);

	// 2. Resolve role
	let resolvedRole: ResolvedRole;
	try {
		resolvedRole = await roleProvider.resolve(spec);
	} catch (err) {
		logger.error("[spawnAgent] Role resolution failed", { agentId, error: String(err) });
		throw err;
	}

	// 3. Assemble context via ContextPipeline
	const phaseInfo: PhaseInfo = {
		phase: (phase ?? "stage") as PhaseInfo["phase"],
		multiAgent: true,
		humanMode: "observer",
	};

	const baseContext = {
		taskDescription: spec.task,
		workspace: process.cwd(),
		swarmDir: ".stp",
		turnNumber: 0,
		phase: phaseInfo,
		accumulated: undefined as unknown as Parameters<typeof contextPipeline.assemble>[2]["accumulated"],
	};

	const assembledContext = await contextPipeline.assemble(
		{ id: spec.id, role: spec.role, task: spec.task },
		phaseInfo,
		baseContext,
	);

	// 4. Resolve model
	const availableModels = modelRegistry.getAvailable();
	const model =
		spec.modelPreference === "smartest"
			? (availableModels
					.slice()
					.sort(
						(a, b) =>
							(typeof b.contextWindow === "number" ? b.contextWindow : 0) -
							(typeof a.contextWindow === "number" ? a.contextWindow : 0),
					)[0] ?? availableModels[0])
			: availableModels[0];
	if (!model) {
		throw new Error(`[spawnAgent] No available model for agent "${spec.id}"`);
	}

	// 5. Build system prompt
	const promptParts: string[] = [];
	if (resolvedRole.systemPrompt) {
		promptParts.push(resolvedRole.systemPrompt);
	}
	if (resolvedRole.guidelines.length > 0) {
		promptParts.push("\n## Guidelines");
		for (const g of resolvedRole.guidelines) {
			promptParts.push(`- ${g}`);
		}
	}
	if (assembledContext.systemPrompt) {
		promptParts.push(`\n${assembledContext.systemPrompt}`);
	}
	const systemPrompt = promptParts.join("\n");

	// 6. Resolve tool names
	const toolSet = new Set<string>();
	for (const t of resolvedRole.tools) toolSet.add(t);
	for (const t of assembledContext.tools) toolSet.add(t);
	for (const t of spec.tools ?? []) toolSet.add(t);
	const toolNames = [...toolSet];

	// 7. Build transformContext from ContextPipeline
	const transformCtx = contextPipeline.toTransformContext(assembledContext, {});

	// 8. Build hook providers (steering/aside/followup queues)
	// Use external queues when provided (for runtime-level message routing),
	// otherwise create local ones (standalone spawn).
	const asideQueue = extAsideQueue ?? [];
	const steeringQueue = extSteeringQueue ?? [];
	const followUpQueue: Array<{ role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }> = [];

	// 9. Create agent session
	const factory = sessionFactory ?? createAgentSession;
	const result = await factory({
		agentKind: "main",
		profileId: spec.profileId,
		model,
		systemPrompt: [systemPrompt],
		toolNames,
		modelRegistry,
		agentId: spec.id,
		agentDisplayName: spec.id,
		settings,
		transformContext: transformCtx,
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		hasUI: false,
		autoApprove: true,
		hasIrcInterrupts: true,
		getSteeringMessages: async () => {
			if (steeringQueue.length === 0) return [];
			return steeringQueue.splice(0);
		},
		getFollowUpMessages: async () => {
			if (followUpQueue.length === 0) return [];
			return followUpQueue.splice(0);
		},
	});

	const session = result.session;

	// 10. Register in AgentRegistry
	try {
		AgentRegistry.global().register({
			id: spec.id,
			displayName: spec.id,
			kind: "main" as const,
			profileId: spec.profileId ?? spec.id,
			role: spec.role,
			session,
			parentId: "Main",
			sessionFile: null,
		});
	} catch {
		// Duplicate registration in tests is harmless
	}

	// 11. Wire aside message provider
	const asideProvider = async () => {
		if (asideQueue.length === 0) return [];
		return asideQueue.splice(0);
	};
	session.agent.setAsideMessageProvider(asideProvider);

	// 12. Wire role
	session.role = spec.role;

	// 13. Wire CommChannel membership
	if (commChannel) {
		commChannel.addMember(agentId);
	}

	// 14. Wire Crew response capture (before starting the agent)
	if (swarmModeController) {
		session.subscribe(event => {
			if (event.type === "agent_end") {
				// Extract final assistant response text
				const msgs = event.messages;
				let lastAssistantText = "";
				for (let i = msgs.length - 1; i >= 0; i--) {
					const msg = msgs[i];
					if (msg.role === "assistant") {
						const content = msg.content;
						if (typeof content === "string") {
							lastAssistantText = content;
						} else if (Array.isArray(content)) {
							lastAssistantText = content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map(c => c.text)
								.join("\n");
						}
						break;
					}
				}
				swarmModeController.onAgentTurnComplete(agentId, lastAssistantText).catch(() => {});
			}
		});
	}

	// 14. After-spawn hook
	await hookPipeline.trigger(
		"agent:afterSpawn",
		{ agentId, role: spec.role, session },
		{ agentId, phase: phase ?? "stage" },
	);

	// 15. Start the agent
	await session.prompt(spec.task);

	return session;
}

/**
 * Spawn multiple agents in parallel.
 */
export async function spawnAgents(specs: AgentSpec[], opts: Omit<SpawnAgentOptions, "spec">): Promise<AgentSession[]> {
	return Promise.all(specs.map(spec => spawnAgent({ ...opts, spec })));
}
