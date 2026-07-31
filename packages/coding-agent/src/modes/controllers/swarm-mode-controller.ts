/**
 * SwarmModeController — Bridges TUI and Crew infrastructure for multi-agent chat.
 *
 * This controller is the single entry point for all swarm-mode operations.
 * It owns the active Crew, manages agent views, and routes user input.
 *
 * Lifecycle:
 *   1. InteractiveMode creates a SwarmModeController on startup
 *   2. User triggers /swarm start → createCrew() → profile selection → CrewManager
 *   3. User input is routed here when a Crew is active (bypassing Main agent LLM)
 *   4. Agent responses are captured and persisted to Crew transcript
 */

import type { Component } from "@satopi/pi-tui";
import { logger } from "@satopi/pi-utils";
import type { AgentProfile, ProfileRegistry } from "../../agent/agent-profile";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { createAgentSession } from "../../sdk";
import { setCurrentSwarmPhase } from "../../swarm/core/state";
import { type AgentRef, AgentRegistry } from "../../registry/agent-registry";
import { CrewManager } from "../../crew/crew-manager";
import type { IrcBus } from "../../irc/bus";
import type { HookPipeline } from "../../hooks/hook-pipeline";
import type { ActivityLogger } from "../../infra/activity-logger";
import type { Theme } from "../theme/theme";
import type { ISwarmOrchestrator } from "../../graph/orchestrator-interface";
import type { GraphRunner } from "../../graph/graph-runner";
import { parseMentions, createCrewMentionResolver } from "../mention-parser";
import { CrewTranscriptView } from "../components/swarm/crew-transcript-view";
import type { CrewTranscriptEntry, CrewTranscriptState } from "../components/swarm/crew-transcript-view";
import { ProfileSelectDialog } from "../components/swarm/profile-select-dialog";
import type { ProfileSelectItem } from "../components/swarm/profile-select-dialog";

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
	/** Project workspace directory. */
	workspace?: string;
	/** Active TUI theme. */
	theme: Theme;
	/** Called when the controller needs a TUI re-render. */
	onRequestRender?: () => void;
	/** Called when a notice/status message should be shown to the user. */
	onNotice?: (level: "info" | "warn" | "error", message: string) => void;
	/** Swarm orchestrator bridge (GraphRunner). Null until a graph is attached. */
	orchestrator?: ISwarmOrchestrator | null;
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

	/** Per-agent conversation views, keyed by agentId. */
	#agentViews = new Map<string, Component>();

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
	 * Updates crew state and broadcasts a notification to the crew channel.
	 */
	attachGraph(graphPath: string): void {
		if (!this.#activeCrewId) {
			this.#deps.onNotice?.("warn", "No active crew — create or focus a crew first");
			return;
		}
		const crew = this.#crewManager.getCrew(this.#activeCrewId);
		if (!crew) {
			this.#deps.onNotice?.("error", `Crew "${this.#activeCrewId}" not found`);
			return;
		}
		crew.state.activeGraph = { graphPath, phase: "idle" };
		const runner = (this.#deps.orchestrator as GraphRunner) ?? null;
		this.#graphRunner = runner;
		if (runner) {
			runner.attachCrew(this.#activeCrewId, crew.channel);
		}
		crew.channel.send("system", `[System] Graph "${graphPath}" activated`).catch(() => {});
		this.#deps.onNotice?.("info", `Graph "${graphPath}" attached to crew "${crew.state.name}"`);
	}

	/** Detach the active graph from the current crew. */
	detachGraph(): void {
		if (!this.#activeCrewId) {
			this.#deps.onNotice?.("warn", "No active crew — nothing to detach");
			return;
		}
		const crew = this.#crewManager.getCrew(this.#activeCrewId);
		if (crew) {
			delete crew.state.activeGraph;
			crew.channel.send("system", "[System] Graph detached — returning to free discussion").catch(() => {});
		}
		this.#graphRunner?.detachCrew();
		this.#graphRunner = null;
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
			throw new Error(`Need at least 2 agent profiles (credit >= 30 recommended but not required); found ${profiles.length}`);
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
			async (selected) => {
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
			const view = new CrewTranscriptView(state, this.#deps.theme);
			this.#crewViews.set(crewId, { crewId, component: view });
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

		const channel = crew.channel;
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
								agentId: mention.agentId, error: String(err),
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
								agentId: memberId, error: String(err),
							}),
						),
					);
				}
			}
		}

		// Fire all prompts in parallel (don't await — agent responses arrive via agent_end events)
		Promise.all(prompts).catch(() => {});

		// Persist the human message to transcript
		await this.#crewManager.persistMessage(this.#activeCrewId, "human", text);

		const crewView = this.#crewViews.get(this.#activeCrewId);
		if (crewView) {
			(crewView.component as CrewTranscriptView).addEntry({
				agentId: "human",
				body: text,
				timestamp: Date.now(),
				round: 1,
			});
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
		const model = availableModels[0];

		// Spawn all agents in parallel — session creation is fast, prompts are fire-and-forget
		const spawns = profileIds.map(async (profileId) => {
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
					systemPrompt: [
						`You are ${name}, a ${archetype} agent.`,
						`Your expertise domains: ${domains || "general"}.`,
						"You are participating in a multi-agent crew chat.",
						"Respond to messages from the user and other agents concisely and helpfully.",
					],
					toolNames: ["read", "grep", "glob"],
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

				// Agent is registered and wired — will start on first IRC message
				logger.info("[SwarmModeController] Crew member registered", { profileId, name });

				logger.info("[SwarmModeController] Crew member spawned", { profileId, name });
			} catch (err) {
				logger.error("[SwarmModeController] Failed to spawn crew member", {
					profileId, error: String(err),
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
				round: 1,
			});
		}

		this.#deps.onRequestRender?.();
	}

	// ========================================================================
	// Agent Views
	// ========================================================================

	/** Open a per-agent conversation view. */
	openAgentView(agentId: string): void {
		// TODO: Phase 1.6 — create AgentConversationView
		this.#deps.onNotice?.("info", `Agent view for ${agentId} — coming in Phase 2`);
	}

	/** Close a per-agent conversation view. */
	closeAgentView(agentId: string): void {
		this.#agentViews.delete(agentId);
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
		this.#agentViews.clear();
		this.#activeCrewId = null;
		await this.#crewManager.disposeAll();
	}
}
