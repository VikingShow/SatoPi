/**
 * SwarmModeController — Bridges TUI and Crew infrastructure for multi-agent chat.
 *
 * This controller is the single entry point for all swarm-mode operations.
 * It owns the active Crew and routes user input.
 *
 * Lifecycle:
 *   1. InteractiveMode creates a SwarmModeController on startup
 *   2. User triggers /swarm start → createCrew() → profile selection → CrewManager
 *   3. User input is routed here when a Crew is active (bypassing Main agent LLM)
 *   4. Agent responses are captured and persisted to Crew transcript
 */

import * as path from "node:path";
import type { Model } from "@satopi/pi-ai";
import type { Component } from "@satopi/pi-tui";
import { logger } from "@satopi/pi-utils";
import type { AgentProfile, ProfileRegistry } from "../../agent/agent-profile";
import type { ModelRegistry } from "../../config/model-registry";
import { resolveModelOverride } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import { CrewManager } from "../../crew/crew-manager";
import { DebateRoundtable } from "../../graph/behaviors/debate-roundtable";
import { GraphRunner } from "../../graph/graph-runner";
import type { HookPipeline } from "../../hooks/hook-pipeline";
import type { ActivityLogger } from "../../infra/activity-logger";
import type { IrcBus } from "../../irc/bus";
import { type AgentRef, AgentRegistry } from "../../registry/agent-registry";
import { createAgentSession } from "../../sdk";
import { setCurrentSwarmPhase } from "../../swarm/core/state";
import { createSwarmInfra } from "../../swarm/core/swarm-infra";
import { SwarmSessionManager } from "../../swarm/session/swarm-session-manager";
import type { CrewTranscriptState } from "../components/swarm/crew-transcript-view";
import { CrewTranscriptView } from "../components/swarm/crew-transcript-view";
import type { ProfileSelectItem } from "../components/swarm/profile-select-dialog";
import { ProfileSelectDialog } from "../components/swarm/profile-select-dialog";
import { createCrewMentionResolver, parseMentions } from "../mention-parser";
import type { Theme } from "../theme/theme";

// ============================================================================
// Types
// ============================================================================

export interface SwarmModeControllerDeps {
	/** Working directory for crew persistence. */
	crewsDir: string;
	/** Process-level IRC bus for inter-agent messaging. */
	ircBus: IrcBus;
	/** Hook pipeline for lifecycle events. */
	hookPipeline?: HookPipeline;
	/** Activity logger for broadcast events. */
	activityLogger?: ActivityLogger;
	/** Profile registry for agent identity/selection. */
	profileRegistry: ProfileRegistry;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
	/** Current model of the host session, used as the crew-member default when no crew.memberModel setting resolves. */
	currentModel?: Model;
	/** Project workspace directory. */
	workspace?: string;
	/** Active TUI theme. */
	theme: Theme;
	/** Called when the controller needs a TUI re-render. */
	onRequestRender?: () => void;
	/** Called when a notice/status message should be shown to the user. */
	onNotice?: (level: "info" | "warn" | "error", message: string) => void;
	/** Called when the user leaves the current crew (via Escape / /swarm off). */
	onLeaveCrew?: () => void;
}

export interface CrewViewHandle {
	/** The crew ID this view is rendering. */
	crewId: string;
	/** The TUI component for this crew view. */
	component: Component;
}

// ============================================================================
// SwarmModeController
// ============================================================================
export class SwarmModeController {
	readonly #deps: SwarmModeControllerDeps;
	readonly #crewManager: CrewManager;

	/** Currently active Crew ID, or null when no Crew is focused. */
	#activeCrewId: string | null = null;

	/** Active GraphRunner when a graph is attached to the active crew. */
	#graphRunner: GraphRunner | null = null;
	/** Active crew views, keyed by crewId. */
	#crewViews = new Map<string, CrewViewHandle>();
	/** Highest round recorded per crew; doubles as the active round for the current turn. */
	#crewRounds = new Map<string, number>();

	/** Pending profile selection dialog shown during crew creation. */
	#pendingDialog: Component | undefined;

	// ========================================================================
	// Constructor
	// ========================================================================

	constructor(deps: SwarmModeControllerDeps) {
		this.#deps = deps;
		this.#crewManager = new CrewManager(deps.crewsDir, deps.ircBus, {
			hookPipeline: deps.hookPipeline,
			activityLogger: deps.activityLogger,
		});
	}

	// ========================================================================
	// Initialization
	// ========================================================================

	/** Restore persisted crews on startup. Call once after construction. */
	async init(): Promise<void> {
		await this.#crewManager.restore();
		logger.info("[SwarmModeController] Initialized", {
			crewCount: this.#crewManager.listCrews().length,
		});
	}

	// ========================================================================
	// Queries
	// ========================================================================

	/** Whether a Crew is currently active (user input should be routed to Crew). */
	isCrewActive(): boolean {
		return this.#activeCrewId !== null;
	}

	/** Get the active crew ID, if any. */
	get activeCrewId(): string | null {
		return this.#activeCrewId;
	}

	/** Leave the current crew and return to normal chat mode. */
	leaveCrew(): void {
		if (!this.#activeCrewId) return;
		logger.info("[SwarmModeController] Leaving crew", { crewId: this.#activeCrewId });
		this.#activeCrewId = null;
		this.#deps.onLeaveCrew?.();
		this.#deps.onNotice?.("info", "Left crew — back to normal chat");
		this.#deps.onRequestRender?.();
	}

	/** Get the CrewManager instance. */
	get crewManager(): CrewManager {
		return this.#crewManager;
	}

	/** Get the active crew's TUI view component, if any. */
	get activeCrewView(): Component | undefined {
		if (!this.#activeCrewId) return undefined;
		return this.#crewViews.get(this.#activeCrewId)?.component;
	}

	/** Get the active crew state, if any. */
	// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- CrewEntry is unexported
	getActiveCrew() {
		if (!this.#activeCrewId) return undefined;
		return this.#crewManager.getCrew(this.#activeCrewId)?.state;
	}

	/** Get the TUI component for a crew view. */
	getCrewView(crewId: string): Component | undefined {
		return this.#crewViews.get(crewId)?.component;
	}

	/** List all available crews. */
	listCrews() {
		return this.#crewManager.listCrews();
	}

	// ========================================================================
	// Graph Management
	// ========================================================================

	/**
	 * Attach a theatre graph to the active crew.
	 *
	 * Builds a real GraphRunner bridge (swarm infra + graph engine), attaches
	 * it to the crew channel for phase-transition broadcasts, and records the
	 * active graph on the crew state. Plan.md writes by crew members are
	 * forwarded to the bridge via the beforeToolCall hook installed in
	 * #spawnCrewMembers.
	 */
	async attachGraph(graphPath: string): Promise<void> {
		if (!this.#activeCrewId) {
			this.#deps.onNotice?.("warn", "No active crew — create or focus a crew first");
			return;
		}
		const crew = this.#crewManager.getCrew(this.#activeCrewId);
		if (!crew) {
			this.#deps.onNotice?.("error", `Crew "${this.#activeCrewId}" not found`);
			return;
		}

		// Re-attach replaces any previous bridge.
		if (this.#graphRunner) {
			await this.detachGraph().catch(err =>
				logger.error("[SwarmModeController] Failed to detach previous graph", { error: String(err) }),
			);
		}

		const { modelRegistry, settings, profileRegistry, workspace } = this.#deps;
		if (!modelRegistry || !settings) {
			this.#deps.onNotice?.("error", "Cannot attach graph: missing modelRegistry or settings");
			return;
		}
		const ws = workspace ?? process.cwd();

		// Resolve the builtin theatre graph to its packaged location; other paths
		// are resolved relative to the project workspace.
		const resolvedPath =
			graphPath === "builtin/theatre.graph.yaml"
				? path.resolve(import.meta.dir, "..", "..", "graph", "builtin", "theatre.graph.yaml")
				: path.resolve(ws, graphPath);

		try {
			// GraphRunner derives its swarmDir identically in graph mode, so the
			// session reader must target the same directory.
			const graphName = path.basename(resolvedPath, ".graph.yaml");
			const swarmDir = path.join(ws, ".stp", "sessions", `swarm-${graphName}`);
			const infra = await createSwarmInfra({
				workspace: ws,
				swarmDir,
				swarmName: graphName,
				modelRegistry,
				settings,
				profileRegistry,
				startPhase: "script",
			});

			const runner = new GraphRunner({
				workspace: ws,
				graphPath: resolvedPath,
				swarmDir,
				modelRegistry,
				settings,
				profileRegistry,
				maxWorkers: (settings.get("magicKeywords.swarm.maxWorkers") as number) ?? 4,
				maxRounds: (settings.get("magicKeywords.swarm.maxRounds") as number) ?? 3,
				autoApplaud: (settings.get("magicKeywords.swarm.autoApplaud") as boolean) ?? false,
				infra,
				onPhaseChange: phase => setCurrentSwarmPhase(phase),
				debateRoundtableFactory: config => new DebateRoundtable(config),
				readSessionEntries: () => SwarmSessionManager.readRawEntries(swarmDir),
			});
			await runner.init();

			runner.attachCrew(this.#activeCrewId, crew.channel);
			this.#graphRunner = runner;
			crew.state.activeGraph = { graphPath, phase: "idle" };
			await crew.channel.send("system", `[System] Graph "${graphPath}" activated`).catch(() => {});
			this.#deps.onNotice?.("info", `Graph "${graphPath}" attached to crew "${crew.state.name}"`);
		} catch (err) {
			logger.error("[SwarmModeController] Failed to attach graph", { error: String(err) });
			this.#deps.onNotice?.("error", `Failed to attach graph: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Launch the Stage phase on the attached graph via the bridge.
	 *
	 * Gated on plan readiness: confirmScript would otherwise run the engine
	 * with an empty plan and the Script node would never complete
	 * (ScriptBehavior only auto-confirms when plan content already exists).
	 */
	async launchGraph(): Promise<void> {
		if (!this.#graphRunner) {
			this.#deps.onNotice?.("error", "No graph attached — run /graph theatre first");
			return;
		}
		if (!this.#graphRunner.isPlanReady()) {
			this.#deps.onNotice?.(
				"error",
				"No plan yet — have the crew write plan.md first (a plan needs headings and at least 200 chars)",
			);
			return;
		}
		try {
			const errors = await this.#graphRunner.confirmScript();
			if (errors.length > 0) {
				for (const error of errors) this.#deps.onNotice?.("error", error);
				return;
			}
			this.#deps.onNotice?.("info", "Stage launched — graph execution started");
		} catch (err) {
			logger.error("[SwarmModeController] Failed to launch graph", { error: String(err) });
			this.#deps.onNotice?.("error", `Failed to launch graph: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** Detach the active graph from the current crew. */
	async detachGraph(): Promise<void> {
		if (!this.#activeCrewId) {
			this.#deps.onNotice?.("warn", "No active crew — nothing to detach");
			return;
		}
		const runner = this.#graphRunner;
		this.#graphRunner = null;
		if (runner) {
			runner.detachCrew();
			await runner
				.dispose()
				.catch(err => logger.error("[SwarmModeController] Failed to dispose graph bridge", { error: String(err) }));
		}
		const crew = this.#crewManager.getCrew(this.#activeCrewId);
		if (crew) {
			delete crew.state.activeGraph;
			await crew.channel.send("system", "[System] Graph detached — returning to free discussion").catch(() => {});
		}
		this.#deps.onNotice?.("info", "Graph detached");
	}

	/** Get the active graph state for the current crew, or null. */
	get activeGraph(): { graphPath: string; phase: string } | null {
		if (!this.#activeCrewId) return null;
		const crew = this.#crewManager.getCrew(this.#activeCrewId);
		return crew?.state.activeGraph ?? null;
	}

	/** Get the pending profile selection dialog, if any. */
	get pendingDialog(): Component | undefined {
		return this.#pendingDialog;
	}

	/** Get available profiles for crew creation. */
	getAvailableProfiles(): AgentProfile[] {
		const qualified = this.#deps.profileRegistry.list().filter(p => p.credit.score >= 30);
		if (qualified.length >= 2) return qualified;
		return this.#deps.profileRegistry.list(); // fallback: show all profiles when < 2 meet threshold
	}

	// ========================================================================
	// Crew Lifecycle
	// ========================================================================

	/**
	 * Create a new Crew and make it the active crew.
	 * @param name - Display name for the crew
	 * @param profileIds - Agent profile IDs to include as members (min 2)
	 * @returns The new crew ID
	 */
	async createCrew(name: string, profileIds: string[]): Promise<string> {
		if (profileIds.length < 2) {
			throw new Error("A crew requires at least 2 agents");
		}

		const crewId = await this.#crewManager.createCrew(name, profileIds);
		await this.focusCrew(crewId);
		this.#deps.onNotice?.("info", `Crew "${name}" created with ${profileIds.length} agents`);
		return crewId;
	}

	/**
	 * Create a new Crew via profile selection dialog.
	 * Shows the dialog, waits for user confirmation, then creates the crew.
	 * @param name - Display name for the crew
	 * @returns The new crew ID
	 */
	async createCrewWithDialog(name: string): Promise<string> {
		const profiles = this.getAvailableProfiles();
		if (profiles.length < 2) {
			throw new Error(
				`Need at least 2 agent profiles (credit >= 30 recommended but not required); found ${profiles.length}`,
			);
		}

		// Build dialog items from profiles
		const items: ProfileSelectItem[] = profiles.map(p => ({
			profileId: p.profileId,
			name: p.identity.name,
			archetype: p.identity.archetype,
			creditScore: p.credit.score,
			successRate: p.credit.successRate,
			domains: p.expertise.domains,
			selected: false,
			warned: p.credit.score < 30,
		}));

		const { promise, resolve, reject } = Promise.withResolvers<string>();

		const dialog = new ProfileSelectDialog(
			items,
			this.#deps.theme,
			async selected => {
				try {
					this.#pendingDialog = undefined;
					// Reset stale swarm phase from previous sessions
					setCurrentSwarmPhase("idle");
					const crewId = await this.#crewManager.createCrew(name, selected);
					await this.focusCrew(crewId);
					// Spawn agent sessions for each selected crew member
					await this.#spawnCrewMembers(selected).catch(err =>
						logger.error("Failed to spawn crew members", { error: String(err) }),
					);
					this.#deps.onNotice?.("info", `Crew "${name}" created with ${selected.length} agents`);
					resolve(crewId);
				} catch (err) {
					reject(err);
				}
			},
			() => {
				this.#pendingDialog = undefined;
				reject(new Error("Cancelled"));
			},
		);

		this.#pendingDialog = dialog;
		return promise;
	}

	/** Focus (switch to) an existing crew. */
	async focusCrew(crewId: string): Promise<void> {
		const crew = this.#crewManager.getCrew(crewId);
		if (!crew) throw new Error(`Crew "${crewId}" not found`);

		this.#activeCrewId = crewId;
		// Create or get the crew view component
		if (!this.#crewViews.has(crewId)) {
			const state: CrewTranscriptState = {
				crew: crew.state,
				topic: crew.state.name,
				converged: false,
				totalRounds: 1,
				entries: [],
			};
			const view = new CrewTranscriptView(state, this.#deps.theme, () => this.leaveCrew());
			this.#crewViews.set(crewId, { crewId, component: view });
			// Fresh view starts before round 1 — the first human message opens round 1
			this.#crewRounds.set(crewId, 0);
		}

		this.#deps.onRequestRender?.();
		logger.info("[SwarmModeController] Focused crew", { crewId });
	}

	/** Dispose a crew and clean up its views. */
	async disposeCrew(crewId: string): Promise<void> {
		if (this.#activeCrewId === crewId) {
			this.#activeCrewId = null;
		}
		this.#crewViews.delete(crewId);
		await this.#crewManager.disposeCrew(crewId);
		this.#deps.onRequestRender?.();
	}

	// Graph orchestrator wiring is handled by attachGraph(graphPath) / detachGraph() above

	// ========================================================================
	// Message Routing
	// ========================================================================

	/**
	 * Handle user input when a Crew is active.
	 * Parses @mentions, routes to specific agents, broadcasts remainder.
	 */
	async handleUserInput(text: string): Promise<void> {
		if (!this.#activeCrewId) return;

		const crew = this.#crewManager.getCrew(this.#activeCrewId);
		if (!crew) return;

		const memberIds = new Set(crew.state.members.map((m: { agentId: string }) => m.agentId));

		// Build resolver from crew members
		const agentRefs = new Map<string, AgentRef>();
		for (const memberId of memberIds) {
			const ref = AgentRegistry.global().get(memberId);
			if (ref) agentRefs.set(memberId, ref);
		}
		const resolveAgent = createCrewMentionResolver(memberIds, agentRefs);

		const parsed = parseMentions(text, resolveAgent);

		// Route directed messages — start agent loop with user's message as prompt
		const prompts: Promise<unknown>[] = [];
		for (const mention of parsed.mentions) {
			if (mention.text) {
				const ref = agentRefs.get(mention.agentId);
				if (ref?.session) {
					prompts.push(
						ref.session.prompt(mention.text).catch(err =>
							logger.error("[SwarmModeController] Agent prompt failed", {
								agentId: mention.agentId,
								error: String(err),
							}),
						),
					);
				}
			}
		}

		// Broadcast messages go to all crew members
		if (parsed.broadcast) {
			for (const [memberId, ref] of agentRefs) {
				if (ref.session) {
					prompts.push(
						ref.session.prompt(parsed.broadcast).catch(err =>
							logger.error("[SwarmModeController] Broadcast prompt failed", {
								agentId: memberId,
								error: String(err),
							}),
						),
					);
				}
			}
		}

		// Fire all prompts in parallel (don't await — agent responses arrive via agent_end events)
		Promise.all(prompts).catch(() => {});

		// Forward the message to the attached graph bridge so the active phase
		// behavior (Script/Curtain) can consume human input (e.g. confirm/applaud).
		if (this.#graphRunner) {
			await this.#graphRunner
				.steer(text)
				.catch(err => logger.error("[SwarmModeController] Graph steer failed", { error: String(err) }));
		}

		// Persist the human message to transcript
		await this.#crewManager.persistMessage(this.#activeCrewId, "human", text);

		// Each human message starts a new round — remember it as the active round for this turn
		const activeRound = (this.#crewRounds.get(this.#activeCrewId) ?? 0) + 1;
		this.#crewRounds.set(this.#activeCrewId, activeRound);

		const crewView = this.#crewViews.get(this.#activeCrewId);
		if (crewView) {
			(crewView.component as CrewTranscriptView).addEntry({
				agentId: "human",
				body: text,
				timestamp: Date.now(),
				round: activeRound,
			});
			this.#syncCrewRound(this.#activeCrewId);
		}

		this.#deps.onRequestRender?.();
	}

	// ========================================================================
	// Agent Spawning
	// ========================================================================

	/**
	 * Spawn agent sessions for selected crew members.
	 * Each agent is registered in AgentRegistry and wired for IRC-based crew chat.
	 */
	async #spawnCrewMembers(profileIds: string[]): Promise<void> {
		const { modelRegistry, settings, profileRegistry } = this.#deps;
		if (!modelRegistry || !settings) {
			logger.warn("[SwarmModeController] Cannot spawn crew members: missing modelRegistry or settings");
			return;
		}

		const availableModels = modelRegistry.getAvailable();
		if (availableModels.length === 0) {
			logger.warn("[SwarmModeController] Cannot spawn crew members: no models available");
			return;
		}
		// Model selection: per-profile model is not part of AgentProfile (yet), so
		// resolve the shared crew.memberModel setting (model selector, default
		// "smartest") first, fall back to the host session's current model when
		// provided via deps, then to the first available model.
		const configuredMemberModel = resolveModelOverride(
			// Empty/undefined selector resolves to no model and falls through the chain.
			[settings.get("crew.memberModel") ?? ""],
			modelRegistry,
			settings,
		).model;
		const model = configuredMemberModel ?? this.#deps.currentModel ?? availableModels[0];

		// Spawn all agents in parallel — session creation is fast, prompts are fire-and-forget
		const spawns = profileIds.map(async profileId => {
			const profile = profileRegistry.get(profileId);
			if (!profile) return;

			const name = profile.identity.name;
			const archetype = profile.identity.archetype;
			const domains = profile.expertise.domains.join(", ");

			try {
				const result = await createAgentSession({
					agentKind: "main",
					profileId,
					agentId: profileId,
					agentDisplayName: name,
					model,
					systemPrompt:
						// Crew-member contract. Future work: move to a prompts/*.md file once
						// prompt-file management lands for crew members (repo rule: prompts live
						// in .md); a plain inline template is intentional for now.
						`You are ${name}, a ${archetype} agent.

Your expertise domains: ${domains || "general"}.

You are a persistent crew member (agent kind "main") of a multi-agent crew — not a one-shot subagent. You stay in the crew across turns, and your replies are recorded in the shared crew transcript. Your agent id is ${profileId}; crewmates and the human may address you with @${profileId}.

Your role in this crew: ${profile.identity.description}.

Rules:
- Reply concisely; no preamble or filler.
- Use your tools (read, grep, glob, edit, write, bash, todo) whenever the task requires inspecting or changing files.
- Watch for @mentions of your agent id; when replying to a specific crewmate, address them by @mention.`,
					toolNames: ["read", "grep", "glob", "edit", "write", "bash", "todo"],
					modelRegistry,
					settings,
					hasIrcInterrupts: true,
				});

				const session = result.session;
				AgentRegistry.global().register({
					id: profileId,
					displayName: name,
					kind: "main" as const,
					profileId,
					session,
					parentId: "Main",
					sessionFile: null,
				});

				// Wire agent response capture to crew transcript
				session.subscribe(event => {
					if (event.type === "agent_end") {
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
						this.onAgentTurnComplete(profileId, lastAssistantText).catch(() => {});
					}
				});

				// Install the plan.md capture hook for graph mode: crew members have
				// write tools, so their plan.md writes feed the attached GraphRunner
				// bridge. Reads the CURRENT bridge on every call — writes before
				// /graph theatre (or after /graph off) are simply dropped. Chains
				// any pre-existing hook so its policy (e.g. blocking) still applies.
				const previousToolHook = session.agent.beforeToolCall;
				session.agent.beforeToolCall = async (ctx, signal) => {
					const previous = previousToolHook ? await previousToolHook(ctx, signal) : undefined;
					if (previous !== undefined) return previous;
					if (ctx.toolCall.name === "write") {
						const args = ctx.args as { path?: string; content?: string };
						if (
							typeof args.path === "string" &&
							args.path.includes("plan.md") &&
							typeof args.content === "string"
						) {
							this.#graphRunner?.onPlanUpdated(args.content);
						}
					}
					return undefined;
				};

				// Agent is registered and wired — will start on first IRC message
				logger.info("[SwarmModeController] Crew member registered", { profileId, name });

				logger.info("[SwarmModeController] Crew member spawned", { profileId, name });
			} catch (err) {
				logger.error("[SwarmModeController] Failed to spawn crew member", {
					profileId,
					error: String(err),
				});
			}
		});

		// Wait for all sessions to be created (not for their LLM prompts to complete)
		await Promise.all(spawns);
	}

	// ========================================================================
	// Agent Response Capture
	// ========================================================================

	/**
	 * Keep the crew view's totalRounds in sync with the tracked round state.
	 * Safe no-op when no view exists for the crew.
	 */
	#syncCrewRound(crewId: string): void {
		const view = this.#crewViews.get(crewId);
		if (!view) return;
		const totalRounds = Math.max(1, this.#crewRounds.get(crewId) ?? 0);
		(view.component as CrewTranscriptView).updateState({ totalRounds });
	}

	/**
	 * Called when a crew member agent finishes a turn.
	 * Persists the response to the crew transcript.
	 */
	async onAgentTurnComplete(agentId: string, finalResponse: string): Promise<void> {
		if (!this.#activeCrewId) return;

		await this.#crewManager.persistMessage(this.#activeCrewId, agentId, finalResponse);

		const crewView = this.#crewViews.get(this.#activeCrewId);
		if (crewView) {
			(crewView.component as CrewTranscriptView).addEntry({
				agentId,
				body: finalResponse,
				timestamp: Date.now(),
				// Replies join the round the current turn started in
				round: this.#crewRounds.get(this.#activeCrewId) ?? 1,
			});
			this.#syncCrewRound(this.#activeCrewId);
		}

		this.#deps.onRequestRender?.();
	}

	// ========================================================================
	// Member Management
	// ========================================================================

	/** Add a member to the active crew. */
	async addMember(agentId: string): Promise<void> {
		if (!this.#activeCrewId) throw new Error("No active crew");
		await this.#crewManager.addMember(this.#activeCrewId, agentId);
		this.#deps.onRequestRender?.();
	}

	/** Remove a member from the active crew. */
	async removeMember(agentId: string): Promise<void> {
		if (!this.#activeCrewId) throw new Error("No active crew");
		await this.#crewManager.removeMember(this.#activeCrewId, agentId);
		this.#deps.onRequestRender?.();
	}

	// ========================================================================
	// Cleanup
	// ========================================================================

	async dispose(): Promise<void> {
		this.#crewViews.clear();

		// Dispose each crew member's agent session and unregister from AgentRegistry
		const registry = AgentRegistry.global();
		for (const crew of this.#crewManager.listCrews()) {
			const entry = this.#crewManager.getCrew(crew.id);
			if (!entry) continue;
			for (const member of entry.state.members) {
				const ref = registry.get(member.agentId);
				if (ref?.session) {
					try {
						await ref.session.dispose();
					} catch (err) {
						logger.error("[SwarmModeController] Failed to dispose crew member session", {
							agentId: member.agentId,
							error: String(err),
						});
					}
				}
				registry.unregister(member.agentId);
			}
		}

		// Dispose any attached graph bridge (detach crew wiring, then dispose).
		const runner = this.#graphRunner;
		this.#graphRunner = null;
		if (runner) {
			runner.detachCrew();
			await runner
				.dispose()
				.catch(err => logger.error("[SwarmModeController] Failed to dispose graph bridge", { error: String(err) }));
		}

		this.#activeCrewId = null;
		await this.#crewManager.disposeAll();
	}
}
