/**
 * EmbeddedSwarmBridge — Bridges interactive agent session ↔ SwarmRunner lifecycle.
 *
 * Created by agent-session when the "swarm" magic keyword is detected.
 * Manages the full Script → Stage → Curtain lifecycle WITHIN an active
 * interactive session, with the human user as a first-class participant.
 *
 * ## Lifecycle (PhaseBehavior-driven)
 *   init()           → creates swarm services, enters ScriptBehavior
 *   onPlanUpdated()  → called when the agent writes plan.md
 *   confirmScript()  → exits ScriptBehavior → enters StageBehavior → CurtainBehavior
 *   steer()          → forwards to current PhaseBehavior.handleHumanMessage
 *   applaud()        → forwards to CurtainBehavior (dismiss / applaud)
 *   dispose()        → tears down all services, exits current behavior
 * Phase transitions are event-driven: agent completion events trigger
 * immediate checkCompletion(). A 5s polling safety net guards edge cases.
 * ## Integration
 *   agent-session.ts  → creates bridge on magic keyword, calls init()
 *   interactive-mode.ts → reads bridge state for dashboard, status line
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ModelRegistry, Settings } from "@satopi/pi-coding-agent";
import { logger } from "@satopi/pi-utils";
import type { AssistantMessage } from "@satopi/pi-ai";
import type { ProfileRegistry } from "../../agent/agent-profile";
import { RoleAssetManager, type RoleAssetManager as RoleAssetManagerType } from "../../agent/role-asset";
import type { MarkEnvironment } from "../../coordination/mark-environment";
import { IrcBus } from "../../irc/bus";
import type { AgentSession } from "../../session/agent-session";
import type { AgentRuntime } from "../agent-runtime";
import { CurtainBehavior } from "../../graph/behaviors/curtain-behavior";
import type { PhaseBehavior, PhaseContext } from "../../graph/behaviors/index";
import { ScriptBehavior } from "../../graph/behaviors/script-behavior";
import { StageBehavior } from "../../graph/behaviors/stage-behavior";
import { ExperienceStore } from "../../experience/experience";
import type { HookPipeline } from "../../hooks/hook-pipeline";
import { ActivityLogger } from "../../infra/activity-logger";
import { DebateRoundtable, type DebateRoundtableResult } from "../script/debate-roundtable";
import { getSessionPlanPath } from "../script/plan-paths";
import { SwarmSessionManager } from "../session/swarm-session-manager";
import { createOrchestratorRuntime } from "./assembler";
import type { LoopSwarmConfig } from "./schema";
import { type Chapter, StateTracker, type SwarmState } from "./state";
import { PHASES, WorkflowFsm } from "./workflow-fsm";

// ============================================================================
// Types
// ============================================================================

export interface EmbeddedSwarmConfig {
	/** Project workspace directory. */
	workspace: string;
	/** Swarm work directory (auto-created as .stp/sessions/swarm-{id}/). */
	swarmDir: string;
	/** Model registry for API key resolution. */
	modelRegistry: ModelRegistry;
	/** Settings for model and tool configuration. */
	settings: Settings;
	/** Optional role asset manager for role resolution (auto-created if omitted). */
	roleAssetManager?: RoleAssetManagerType;
	/** Optional profile registry for agent identity. */
	profileRegistry?: ProfileRegistry;
	/** Optional user-specified max worker count (default 4). */
	maxWorkers?: number;
	/** Optional user-specified max rounds (default 3). */
	maxRounds?: number;
	/** Whether to auto-applaud after Curtain (default: false). */
	autoApplaud?: boolean;
	/** Active MMD content for MmdSource context injection. */
	activeMmd?: string;
}

export interface SwarmPhaseEvent {
	phase: Chapter;
	subStatus: string;
	progress?: {
		currentWave?: number;
		totalWaves?: number;
		completedTasks?: number;
		totalTasks?: number;
	};
}

export interface SwarmAgentEvent {
	agentId: string;
	status: string;
	output?: string;
	error?: string;
}

// ============================================================================
// ISwarmOrchestrator — shared interface for SwarmRunner and GraphRunner
// ============================================================================

/**
 * Common orchestrator interface implemented by both EmbeddedSwarmBridge
 * (magic keyword) and GraphRunner (theatre graph engine).  TUI components
 * and agent-session reference this interface so the engine is swappable.
 */
export interface ISwarmOrchestrator {
	init(): Promise<void>;
	dispose(): Promise<void>;
	onPlanUpdated(content: string): void;
	getPlanContent(): string;
	confirmScript(opts?: { agentType?: "swift" | "persistent"; agentCount?: number }): Promise<string[]>;
	setAgentConfig(opts: { agentType?: "swift" | "persistent"; agentCount?: number }): void;
	steer(message: string): Promise<void>;
	applaud(): void;
	pauseStage(): Promise<void>;
	/** Resume graph execution from last checkpoint. Returns success/error. */
	resumeGraphRun?(): Promise<{ success: boolean; error?: string }>;
	/**
	 * Run plan debate and return results without affecting FSM state.
	 * Returns undefined when debate is not enabled. Callers should:
	 * 1. Replace the displayed plan with result.refinedPlan
	 * 2. Use the round data to build a diff-based annotation summary
	 */
	debatePlan?(planContent: string): Promise<DebateRoundtableResult | undefined>;
	readonly fsm: WorkflowFsm;
	readonly stateTracker: StateTracker;
	readonly activityLogger: ActivityLogger;
	readonly swarmState: Readonly<SwarmState>;
	readonly currentPhase: Chapter | null;
	readonly isRunning: boolean;
	readonly runtime: AgentRuntime;
	/** Whether the Stage phase has been started (confirmScript was called and succeeded). */
	readonly stageStarted: boolean;
}
export type SwarmEventCallback = (event: SwarmPhaseEvent | SwarmAgentEvent) => void;

// ============================================================================
// Plan validation helpers
// ============================================================================

/**
 * Validate task checklist items in a plan.
 * Each `- [ ] ...` task must have at least 2 of: Files:, Change:, Acceptance:.
 * Returns error messages for each failing section/task.
 */
export function validatePlanTasks(planContent: string): string[] {
	const errors: string[] = [];

	// Find all ## Phase headings
	const sectionRegex = /^##\s+Phase\b[^\n]*$(?:\n(?!##\s).*)*/gm;
	const sections = [...planContent.matchAll(sectionRegex)];

	for (const sectionMatch of sections) {
		const sectionText = sectionMatch[0];
		const sectionTitle = sectionMatch[0].split("\n")[0].trim();

		// Find task checklist items
		const taskRegex = /^- \[ \].+/gm;
		const tasks = [...sectionText.matchAll(taskRegex)];

		for (let i = 0; i < tasks.length; i++) {
			const taskLine = tasks[i][0];
			const taskIndex = tasks[i].index!;
			const afterTask = sectionText.slice(taskIndex + taskLine.length);
			const afterTaskStart = afterTask.startsWith("\n") ? 1 : 0;
			const continuationEnd = afterTask.slice(afterTaskStart).search(/^(?![\t ])/m);
			const adjustedEnd = continuationEnd === -1 ? undefined : afterTaskStart + continuationEnd;
			const taskBlock = afterTask.slice(0, adjustedEnd);
			const fullTaskText = taskLine + taskBlock;

			const hasFiles = /\bFiles:/.test(fullTaskText);
			const hasChange = /\bChange:/.test(fullTaskText);
			const hasAcceptance = /\bAcceptance:/.test(fullTaskText);
			const matchCount = [hasFiles, hasChange, hasAcceptance].filter(Boolean).length;

			if (matchCount < 2) {
				const missing: string[] = [];
				if (!hasFiles) missing.push("Files:");
				if (!hasChange) missing.push("Change:");
				if (!hasAcceptance) missing.push("Acceptance:");
				const taskDesc = taskLine
					.replace(/^- \[ \]\s*/, "")
					.trim()
					.slice(0, 60);
				errors.push(
					`${sectionTitle}: task "${taskDesc}${taskDesc.length >= 60 ? "..." : ""}" ` +
						`is missing ${missing.join(", ")} (needs at least 2 of: Files:, Change:, Acceptance:)`,
				);
			}
		}
	}

	// Also check tasks outside of ## Phase sections
	const phaseSectionRegex = /^##\s+Phase\b[^\n]*$(?:\n(?!##\s).*)*/gm;
	const withoutPhases = planContent.replace(phaseSectionRegex, "");
	const globalTasks = [...withoutPhases.matchAll(/^- \[ \].+/gm)];

	for (let i = 0; i < globalTasks.length; i++) {
		const taskLine = globalTasks[i][0];
		const taskIndex = globalTasks[i].index!;
		const afterTask = withoutPhases.slice(taskIndex + taskLine.length);
		const continuationEnd = afterTask.search(/^(?![\t ])/m);
		const taskBlock = afterTask.slice(0, continuationEnd === -1 ? undefined : continuationEnd);
		const fullTaskText = taskLine + taskBlock;

		const hasFiles = /\bFiles:/.test(fullTaskText);
		const hasChange = /\bChange:/.test(fullTaskText);
		const hasAcceptance = /\bAcceptance:/.test(fullTaskText);
		const matchCount = [hasFiles, hasChange, hasAcceptance].filter(Boolean).length;

		if (matchCount < 2) {
			const missing: string[] = [];
			if (!hasFiles) missing.push("Files:");
			if (!hasChange) missing.push("Change:");
			if (!hasAcceptance) missing.push("Acceptance:");
			const taskDesc = taskLine
				.replace(/^- \[ \]\s*/, "")
				.trim()
				.slice(0, 60);
			errors.push(
				`Preamble: task "${taskDesc}${taskDesc.length >= 60 ? "..." : ""}" ` +
					`is missing ${missing.join(", ")} (needs at least 2 of: Files:, Change:, Acceptance:)`,
			);
		}
	}

	return errors;
}

// EmbeddedSwarmBridge
// ============================================================================

export class EmbeddedSwarmBridge implements ISwarmOrchestrator {
	readonly #config: EmbeddedSwarmConfig;
	#fsm!: WorkflowFsm;
	#stateTracker!: StateTracker;
	#activityLogger!: ActivityLogger;
	#sessionManager!: SwarmSessionManager;
	#experienceStore!: ExperienceStore;
	#hookPipeline!: HookPipeline;
	#runtime!: AgentRuntime;
	/** Stigmergic MarkEnvironment from orchestrator runtime. */
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: set from orch.markEnvironment
	#markEnv?: MarkEnvironment;
	#planContent = "";
	#planReady = false;
	#agentType: "swift" | "persistent" | undefined = undefined;
	#listener: SwarmEventCallback;
	#abortController: AbortController | null = null;
	#loopConfig: LoopSwarmConfig;
	#disposed = false;
	/** Human-decision resolver for applaud flow. */
	#applaudResolve: (() => void) | null = null;

	// ── PhaseBehavior instances ─────────────────────────────────────────
	#scriptBehavior!: ScriptBehavior;
	#stageBehavior!: StageBehavior;
	#curtainBehavior!: CurtainBehavior;
	#currentBehavior: PhaseBehavior | null = null;
	/** Active agent event unsubscriptions for the current phase. */
	#agentUnsubscribes: Array<() => void> = [];
	/** Promise that resolves when the current stage+curtain lifecycle completes. */
	#lifecyclePromise: Promise<void> | null = null;
	/** Resolver for #lifecyclePromise — set when a phase lifecycle is in flight. */
	#lifecycleResolve: (() => void) | null = null;
	/** Resolver for the poll timer — triggered immediately when an agent event signals phase completion. */
	#pollResolve: (() => void) | null = null;
	/** Set to true when confirmScript() successfully starts the Stage phase. */
	#stageStarted = false;

	constructor(config: EmbeddedSwarmConfig, listener: SwarmEventCallback) {
		this.#config = config;
		this.#listener = listener;
		this.#loopConfig = {
			maxIterations: config.maxRounds ?? 3,
			autoRetry: true,
			enableDeliberation: false,
			humanEscalation: true,
			agents: {
				initial: config.maxWorkers ?? 4,
				min: 1,
				max: config.maxWorkers ?? 4,
				auto: false,
				maxRounds: config.maxRounds ?? 3,
				roundsConvergenceThreshold: 2,
			},
			debate: { enabled: false, maxRounds: 2 },
			planDebate: { enabled: false, agentCount: 2, maxRounds: 2, convergenceThreshold: 2 },
			convergenceThreshold: 2,
			iterationTimeoutMs: 300_000,
		};
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────

	/** Initialize all swarm services. Called once after construction. */
	async init(): Promise<void> {
		const { workspace, swarmDir, modelRegistry, settings, profileRegistry } = this.#config;
		let { roleAssetManager } = this.#config;

		// 1. Create swarm workspace directories
		await fs.mkdir(swarmDir, { recursive: true });
		await fs.mkdir(path.join(swarmDir, ".session"), { recursive: true });

		// 2. Create SwarmSessionManager for persistence
		this.#sessionManager = await SwarmSessionManager.create(swarmDir);

		// 3. Create StateTracker
		const swarmName = path.basename(swarmDir);

		this.#stateTracker = new StateTracker(workspace, swarmName);
		this.#stateTracker.setSessionManager(this.#sessionManager);

		// 4. Create ActivityLogger
		this.#activityLogger = new ActivityLogger(swarmDir, swarmName);
		this.#activityLogger.setSessionManager(this.#sessionManager);

		// 5. Create WorkflowFSM — start in "script" phase
		this.#fsm = new WorkflowFsm(this.#stateTracker, this.#activityLogger, "script");
		for (const def of PHASES) this.#fsm.registerPhase(def);

		// Subscribe to FSM phase changes → forward to listener
		this.#fsm.onChange(event => {
			this.#listener({
				phase: event.to,
				subStatus: event.meta?.reason ?? "",
			});
			// Persist phase in StateTracker
			this.#stateTracker.updatePipeline({ phase: event.to }).catch(() => {});
		});

		// 6. Create ExperienceStore
		this.#experienceStore = new ExperienceStore(workspace);
		await this.#experienceStore.init();

		// 7. Auto-create RoleAssetManager if not provided
		if (!roleAssetManager) {
			roleAssetManager = new RoleAssetManager(workspace);
			await roleAssetManager.init();
		}
		// 8. Create orchestrator runtime (MarkEnvironment + HookPipeline + builtins + AgentRuntime)
		const orch = createOrchestratorRuntime({
			modelRegistry,
			settings,
			activityLogger: this.#activityLogger,
			roleAssetManager,
			experienceStore: this.#experienceStore,
			profileRegistry,
			activeMmd: this.#config.activeMmd,
			ircBus: IrcBus.global(),
		});
		this.#hookPipeline = orch.hookPipeline;
		this.#markEnv = orch.markEnvironment;
		this.#runtime = orch.runtime;

		// 9. Create PhaseBehavior instances
		this.#scriptBehavior = new ScriptBehavior();
		this.#stageBehavior = new StageBehavior();
		this.#curtainBehavior = new CurtainBehavior();

		// 10. Enter Script phase via ScriptBehavior
		const scriptCtx = this.#buildPhaseContext();
		const scriptResult = await this.#scriptBehavior.enter(scriptCtx);
		this.#currentBehavior = this.#scriptBehavior;
		this.#wireAgentEvents(scriptResult.agents);

		// 11. Notify: script phase started
		this.#listener({ phase: "script", subStatus: "planning" });
		logger.info("[EmbeddedSwarmBridge] Initialized", { swarmDir, swarmName });
	}

	/** Tear down all services. Idempotent. */
	async dispose(): Promise<void> {
		if (this.#disposed) return;
		// Persist agent profiles before teardown
		await this.#config.profileRegistry?.save(this.#config.workspace);
		this.#disposed = true;
		this.#abortController?.abort();
		this.#applaudResolve?.();
		this.#pollResolve?.();
		// Wait for active lifecycle to settle
		if (this.#lifecyclePromise) {
			try {
				await this.#lifecyclePromise;
			} catch {
				/* best-effort */
			}
		}
		// Exit current behavior
		if (this.#currentBehavior) {
			await this.#currentBehavior.exit().catch(() => {});
			this.#currentBehavior = null;
		}
		this.#unwireAgentEvents();
		try {
			this.#experienceStore.close();
		} catch {
			/* best-effort */
		}
		this.#planContent = "";
		this.#planReady = false;
		logger.info("[EmbeddedSwarmBridge] Disposed");
	}

	// ── PhaseContext builder ───────────────────────────────────────────────

	/**
	 * Build a PhaseContext from current bridge services.
	 * Callers pass optional planContent override (e.g. the validated plan
	 * after debate has refined it).
	 */
	#buildPhaseContext(planContent?: string): PhaseContext {
		return {
			fsm: this.#fsm,
			ircBus: this.#runtime.ircBus,
			runtime: this.#runtime,
			contextPipeline: this.#runtime.contextPipeline,
			hookPipeline: this.#hookPipeline,
			stateTracker: this.#stateTracker,
			activityLogger: this.#activityLogger,
			workspace: this.#config.workspace,
			swarmDir: this.#config.swarmDir,
			planContent: planContent ?? this.#planContent,
			loopConfig: this.#loopConfig,
			signal: this.#abortController?.signal ?? new AbortController().signal,
		};
	}

	// ── Agent event wiring ─────────────────────────────────────────────────

	/**
	 * Subscribe to AgentSession lifecycle events and forward them to
	 * the current behavior's handleAgentEvent.
	 */
	#wireAgentEvents(agents: AgentSession[]): void {
		this.#unwireAgentEvents();
		for (const agent of agents) {
			const unsub = agent.subscribe(event => {
				if (event.type === "agent_end") {
					const lastAssistant = [...event.messages]
						.reverse()
						.find((message): message is AssistantMessage => message.role === "assistant");
					const stopReason: string | undefined = lastAssistant?.stopReason;
					const status =
						stopReason === "aborted"
							? "aborted"
							: stopReason === "error" || stopReason === "max_turns"
								? "failed"
								: "completed";
					const ctx = this.#buildPhaseContext();
					this.#currentBehavior
						?.handleAgentEvent({ agentId: agent.id, status, result: event }, ctx)
						.catch(err => logger.error("handleAgentEvent failed", { error: String(err) }))
						.then(() => {
							// Event-driven transition: check completion immediately
							if (this.#currentBehavior && this.#pollResolve) {
								this.#currentBehavior
									.checkCompletion(this.#buildPhaseContext())
									.then(completion => {
										if (completion) this.#pollResolve?.();
									})
									.catch(() => {});
							}
						});
				}
			});
			this.#agentUnsubscribes.push(unsub);
		}
	}

	/** Unsubscribe all agent event listeners. Idempotent. */
	#unwireAgentEvents(): void {
		for (const unsub of this.#agentUnsubscribes) unsub();
		this.#agentUnsubscribes = [];
	}

	/**
	 * Run the full phase lifecycle loop starting from a given behavior.
	 *
	 * Primary path: agent events (via #wireAgentEvents) trigger immediate
	 * checkCompletion() after handleAgentEvent(). The polling timer is a
	 * 5s safety net for edge cases where an event might be missed.
	 *
	 * When a phase completes, transitions the FSM, exits the old behavior,
	 * enters the next, and continues. Resolves the stored lifecycle promise
	 * when idle is reached.
	 */
	async #runPhaseLifecycle(startBehavior: PhaseBehavior, ctx: PhaseContext): Promise<void> {
		let behavior = startBehavior;
		let phaseCtx = ctx;

		while (!this.#disposed) {
			const { promise: pollPromise, resolve: pollResolve } = Promise.withResolvers<void>();
			const timer = setTimeout(pollResolve, 5000);
			// Store resolver so agent event handlers can trigger immediate transition
			this.#pollResolve = pollResolve;
			try {
				await pollPromise;
			} finally {
				this.#pollResolve = null;
			}
			clearTimeout(timer);

			if (this.#disposed) return;

			const completion = await behavior.checkCompletion(phaseCtx);
			if (!completion) continue;

			// Phase complete — exit current behavior
			await behavior.exit().catch(err => logger.error("behavior.exit failed", { error: String(err) }));
			this.#unwireAgentEvents();
			this.#currentBehavior = null;

			// Handle transition based on nextPhase
			switch (completion.nextPhase) {
				case "stage": {
					await this.#fsm.transition("stage", {
						reason: completion.message ?? "stage phase starting",
					});
					this.#abortController = new AbortController();
					const stageCtx = this.#buildPhaseContext(phaseCtx.planContent);
					const stageResult = await this.#stageBehavior.enter(stageCtx);
					this.#currentBehavior = this.#stageBehavior;
					this.#wireAgentEvents(stageResult.agents);
					this.#listener({
						phase: "stage",
						subStatus: stageResult.initialUIMessage ?? "executing",
					});
					behavior = this.#stageBehavior;
					phaseCtx = stageCtx;
					continue;
				}

				case "curtain": {
					await this.#fsm.transition("curtain", {
						reason: completion.message ?? "curtain phase starting",
					});
					const curtainCtx = this.#buildPhaseContext();
					const curtainResult = await this.#curtainBehavior.enter(curtainCtx);
					this.#currentBehavior = this.#curtainBehavior;
					this.#wireAgentEvents(curtainResult.agents);
					this.#listener({
						phase: "curtain",
						subStatus: curtainResult.initialUIMessage ?? "reporting",
					});

					// If auto-applaud, immediately signal applaud to the behavior
					if (this.#config.autoApplaud) {
						await this.#curtainBehavior
							.handleHumanMessage({ from: "human", body: "applaud" }, curtainCtx)
							.catch(() => {});
					}

					behavior = this.#curtainBehavior;
					phaseCtx = curtainCtx;
					continue;
				}

				case "idle": {
					if (completion.needApplaud && !this.#config.autoApplaud) {
						// Wait for human applaud
						this.#listener({ phase: "curtain", subStatus: "awaiting applaud" });
						const { promise: applaudPromise, resolve: applaudResolve } = Promise.withResolvers<void>();
						this.#applaudResolve = applaudResolve;
						const CURTAIN_TIMEOUT_MS = 300_000;
						const timeout = setTimeout(() => {
							if (this.#applaudResolve) {
								this.#applaudResolve();
								this.#applaudResolve = null;
							}
						}, CURTAIN_TIMEOUT_MS);
						await applaudPromise;
						clearTimeout(timeout);
						this.#applaudResolve = null;
					}

					await this.#fsm.transition("idle", {
						reason: completion.message ?? "complete",
					});
					this.#listener({
						phase: "idle",
						subStatus: "complete",
					});
					this.#lifecycleResolve?.();
					this.#lifecycleResolve = null;
					return;
				}

				case "script":
				case "script-confirm":
				case "script-debate": {
					// Re-plan path (human dissatisfied → return to script)
					await this.#fsm.transition("script", {
						reason: completion.message ?? "re-planning",
					});
					this.#listener({ phase: "script", subStatus: "re-planning" });
					const reScriptCtx = this.#buildPhaseContext();
					this.#scriptBehavior = new ScriptBehavior();
					const reScriptResult = await this.#scriptBehavior.enter(reScriptCtx);
					this.#currentBehavior = this.#scriptBehavior;
					this.#wireAgentEvents(reScriptResult.agents);
					behavior = this.#scriptBehavior;
					phaseCtx = reScriptCtx;
					continue;
				}

				default:
					// Unknown nextPhase — go idle
					await this.#fsm.transition("idle", { reason: "unknown phase" }).catch(() => {});
					this.#lifecycleResolve?.();
					this.#lifecycleResolve = null;
					return;
			}
		}
	}

	// ── Script Phase ───────────────────────────────────────────────────────

	/** Called by agent-session when the agent writes/updates plan.md. Persists to disk at the swarm session path so confirmScript() can read it. */
	onPlanUpdated(content: string): void {
		this.#planContent = content;
		const planPath = getSessionPlanPath(this.#config.swarmDir);
		// Fire-and-forget persist — the file may not exist yet if this is the
		// first write during the Script phase, so ensure parent dirs exist.
		fs.mkdir(path.dirname(planPath), { recursive: true })
			.then(() => fs.writeFile(planPath, content, "utf-8"))
			.catch(err => logger.warn("[EmbeddedSwarmBridge] Failed to persist plan.md", { error: String(err) }));
		const hasHeadings = /^#{1,3}\s+/m.test(content);
		const minLength = content.trim().length >= 200;
		this.#planReady = hasHeadings && minLength;
		if (this.#planReady) {
			this.#listener({ phase: "script", subStatus: "plan ready for review" });
		}
	}

	/** Get the current plan content. */
	getPlanContent(): string {
		return this.#planContent;
	}

	/** Is the plan ready? (has content and meets minimum structure). */
	isPlanReady(): boolean {
		return this.#planReady;
	}

	/** Set agent type and count from plan review confirmation TUI. */
	setAgentConfig(opts: { agentType?: "swift" | "persistent"; agentCount?: number }): void {
		if (opts.agentCount !== undefined && opts.agentCount >= 1) {
			this.#loopConfig.agents.initial = opts.agentCount;
		}
		if (opts.agentType !== undefined) {
			this.#agentType = opts.agentType;
		}
	}

	/**
	 * Run the plan debate and return structured results without affecting FSM
	 * state. Callers (plan-review UI) use this to:
	 *   1. Replace the displayed plan with result.refinedPlan
	 *   2. Build a diff summary from result.draftPlan → result.refinedPlan
	 *   3. Extract round data for annotation display
	 *
	 * Returns undefined when the `magicKeywords.swarm.enableDebate` setting is
	 * false or unset.
	 */
	async debatePlan(planContent: string): Promise<DebateRoundtableResult | undefined> {
		const enableDebate = (this.#config.settings.get("magicKeywords.swarm.enableDebate") as boolean) ?? false;
		if (!enableDebate) return undefined;

		const debate = new DebateRoundtable({
			agentCount: 2,
			maxRounds: 2,
			convergenceThreshold: 2,
			runtime: this.#runtime,
		});
		try {
			return await debate.debate(
				planContent,
				this.#config.workspace,
				this.#config.modelRegistry,
				this.#config.settings,
			);
		} catch (err) {
			logger.warn("[EmbeddedSwarmBridge] Plan debate failed, returning undefined", {
				error: String(err),
			});
			return undefined;
		}
	}

	/**
	 * Validate the plan & transition to Stage via PhaseBehavior lifecycle.
	 * Returns validation errors as string[], or empty if valid.
	 */
	async confirmScript(opts?: { agentType?: "swift" | "persistent"; agentCount?: number }): Promise<string[]> {
		const planPath = getSessionPlanPath(this.#config.swarmDir);

		// Re-read plan from disk
		let planContent: string;
		try {
			planContent = await fs.readFile(planPath, "utf-8");
		} catch {
			return ["plan.md not found — agent must write a plan before confirming"];
		}

		// Validate plan structure
		const errors: string[] = [];

		// Phase heading check: plan must have at least one ## Phase heading
		const phaseHeadings = [...planContent.matchAll(/^##\s+Phase\b/gm)];
		if (phaseHeadings.length === 0) {
			errors.push('plan.md must contain at least one "## Phase" heading');
		}

		// Length check: plan must be substantial
		if (planContent.trim().length < 200) {
			errors.push("plan.md is too short (< 200 chars) — plan appears incomplete");
		}

		// Task checklist validation: each - [ ] must have at least 2 of: Files:, Change:, Acceptance:
		const taskErrors = validatePlanTasks(planContent);
		errors.push(...taskErrors);

		if (errors.length > 0) return errors;

		this.#planContent = planContent;
		this.#planReady = true;
		// Apply agent config from caller before starting stage
		if (opts) this.setAgentConfig(opts);

		// Transition: script → script-confirm
		const confirmResult = await this.#fsm.transition("script-confirm", {
			reason: "human confirmed plan",
		});
		if (!confirmResult.ok) return [confirmResult.reason ?? "FSM rejected script-confirm transition"];

		// Optional: run plan debate if enabled via settings
		const debateResult = await this.debatePlan(planContent);
		if (debateResult) {
			const debateFsm = await this.#fsm.transition("script-debate", {
				reason: "starting plan debate",
			});
			if (!debateFsm.ok) return [debateFsm.reason ?? "FSM rejected script-debate transition"];

			this.#listener({ phase: "script-debate", subStatus: "debating plan" });

			planContent = debateResult.refinedPlan;
			// Re-write refined plan to disk for Stage
			await fs.writeFile(planPath, planContent, "utf-8");
			this.#planContent = planContent;
			logger.info("[EmbeddedSwarmBridge] Plan debate complete", {
				converged: debateResult.converged,
				rounds: debateResult.rounds.length,
			});

			// Return to script-confirm before stage transition
			const postDebateResult = await this.#fsm.transition("script-confirm", {
				reason: "debate complete",
			});
			if (!postDebateResult.ok)
				return [postDebateResult.reason ?? "FSM rejected script-confirm transition after debate"];
		}

		// Exit ScriptBehavior — the plan is confirmed
		await this.#scriptBehavior
			.exit()
			.catch(err => logger.error("ScriptBehavior.exit failed", { error: String(err) }));
		this.#unwireAgentEvents();
		this.#currentBehavior = null;

		// Transition: script-confirm → stage
		const stageResult = await this.#fsm.transition("stage", {
			reason: "starting stage execution",
		});
		if (!stageResult.ok) return [stageResult.reason ?? "FSM rejected stage transition"];

		// Enter StageBehavior and kick off the phase lifecycle
		this.#abortController = new AbortController();
		const stageCtx = this.#buildPhaseContext(planContent);
		const stageEnterResult = await this.#stageBehavior.enter(stageCtx);
		this.#currentBehavior = this.#stageBehavior;
		this.#wireAgentEvents(stageEnterResult.agents);
		this.#listener({
			phase: "stage",
			subStatus: stageEnterResult.initialUIMessage ?? "executing",
		});
		this.#stageStarted = true;

		// Start async phase lifecycle loop (stage → curtain → idle)
		const { promise: lifecyclePromise, resolve: lifecycleResolve } = Promise.withResolvers<void>();
		this.#lifecyclePromise = lifecyclePromise;
		this.#lifecycleResolve = lifecycleResolve;
		this.#runPhaseLifecycle(this.#stageBehavior, stageCtx)
			.catch(err => {
				logger.error("[EmbeddedSwarmBridge] Phase lifecycle failed", { error: String(err) });
				this.#listener({ phase: "stage", subStatus: `lifecycle error: ${String(err)}` });
				this.#lifecycleResolve?.();
				this.#lifecycleResolve = null;
			})
			.finally(() => {
				this.#lifecyclePromise = null;
			});

		return [];
	}

	/** Dismiss the curtain confirmation dialog / applaud. */
	applaud(): void {
		// Forward applaud to CurtainBehavior if active
		if (this.#currentBehavior === this.#curtainBehavior) {
			const ctx = this.#buildPhaseContext();
			this.#curtainBehavior
				.handleHumanMessage({ from: "human", body: "applaud" }, ctx)
				.catch(err => logger.error("CurtainBehavior applaud failed", { error: String(err) }));
		}
		// Also resolve the legacy applaud resolver for backward compat
		this.#applaudResolve?.();
		this.#applaudResolve = null;
	}

	// ── Steering ───────────────────────────────────────────────────────────

	/** Route a human steering message to the current behavior. */
	async steer(message: string): Promise<void> {
		if (this.#currentBehavior) {
			const ctx = this.#buildPhaseContext();
			await this.#currentBehavior.handleHumanMessage({ from: "human", body: message }, ctx);
		}
		// Also deliver via IrcBus for backward compat
		await this.#runtime.ircBus.receiveFromHuman(message);
	}

	/** Pause the current stage. */
	async pauseStage(): Promise<void> {
		this.#abortController?.abort();
		await this.#fsm.transition("paused", { reason: "human paused stage" });
	}

	// ── Accessors ──────────────────────────────────────────────────────────

	get fsm(): WorkflowFsm {
		return this.#fsm;
	}

	get stateTracker(): StateTracker {
		return this.#stateTracker;
	}

	get activityLogger(): ActivityLogger {
		return this.#activityLogger;
	}

	get swarmState() {
		return this.#stateTracker.state;
	}

	get currentPhase(): Chapter | null {
		return this.#fsm?.phase ?? null;
	}

	get runtime(): AgentRuntime {
		return this.#runtime;
	}

	get isRunning(): boolean {
		return !this.#disposed && (this.#fsm?.state.running ?? false);
	}
	get stageStarted(): boolean {
		return this.#stageStarted;
	}
}
