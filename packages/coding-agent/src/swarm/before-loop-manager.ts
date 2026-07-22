/**
 * BeforeLoopManager — Manages the Before Loop interactive planning phase.
 *
 * Data flow:
 *   1. start(task) → spawn Socrates agent → output via SSE → frontend ChatView
 *   2. sendMessage(text) → user msg via SSE → spawn Socrates with full history → output via SSE
 *   3. runDebate() → runPlanDebate() → refined plan.md → plan-updated event via SSE
 *   4. confirm() → SwarmRunManager.start() → loop runs → phase becomes "running"
 *
 * Each stage updates StateTracker.loopPhase so the frontend can react.
 * All agent output is pushed to the frontend via ActivityLogger → SSE.
 */

import * as fs from "node:fs/promises";
import type { ModelRegistry, Settings, AgentDefinition, AgentSource } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import type { StateTracker, LoopPhase } from "./state";
import type { ActivityLogger } from "./activity-logger";
import type { ExperienceStore } from "./after-loop/experience";
import type { RunManager } from "./monitor/api-routes";
import type { SwarmSessionManager } from "./swarm-session-manager";
import { generatePlanningPrompt, runPlanDebate } from "./before-loop";
import { streamAgentOutput } from "./streaming";
import { getSessionPlanPath } from "./plan-paths";
import { parseSwarmYaml, validateSwarmDefinition, type LoopSwarmConfig, type AgentToolRestriction } from "./schema";
import SOCRATES_SYSTEM_PROMPT from "./prompts/socrates.hbs" with { type: "text" };

// ============================================================================
// Types
// ============================================================================

export interface BeforeLoopState {
	phase: LoopPhase;
	task: string;
	conversationLength: number;
	planReady: boolean;
	busy: boolean;
}

interface ConversationTurn {
	role: "user" | "assistant";
	content: string;
}

/**
 * Default tool restriction for Socrates — read + write (for plan.md) + grep + find.
 * No bash/shell execution, no edit. Can be overridden via agent_restrictions.socrates in YAML.
 * write_allowlist restricts the write tool to only plan.md so Socrates cannot modify
 * arbitrary workspace files.
 */
const SOCRATES_DEFAULT_RESTRICTION: AgentToolRestriction = {
	allowed: ["read", "write", "grep", "find", "glob"],
	write_allowlist: ["plan.md"],
};

/**
 * Extract the human-readable message from a Socrates response. Socrates is
 * instructed to respond in plain natural language but occasionally wraps
 * its reply in a JSON envelope like {"status":"...","message":"..."}.
 * For those cases we surface only the `message` field. Otherwise we
 * return the original text untouched.
 */
function parseSocratesResponse(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return raw;
	try {
		const obj = JSON.parse(trimmed);
		// Extract human-readable content from common JSON wrapper shapes.
		// Ordered by conversational relevance.
		const textKeys = ["plan", "message", "text", "response", "reply", "content", "answer", "summary"];
		for (const key of textKeys) {
			if (typeof obj?.[key] === "string" && obj[key].length > 0) {
				if (key === "plan" && obj.status === "ready") return "[Plan Ready]\n\n" + obj[key];
				return obj[key];
			}
		}
		if (typeof obj?.error === "string" && obj.error.length > 0) {
			return obj.error;
		}
		// questions array (e.g. {"status":"waiting_for_clarification","questions":[...]})
		if (Array.isArray(obj?.questions) && obj.questions.length > 0) {
			const qs = obj.questions.filter((q: unknown) => typeof q === "string").join("\n- ");
			return `Waiting for clarification:\n- ${qs}`;
		}
		// Bare status — short diagnostic, not prettified JSON.
		if (typeof obj?.status === "string") return `(${obj.status})`;
		// Last resort: return raw text rather than JSON.stringify — even
		// unstructured prose is more readable than a formatted JSON blob.
	} catch {
		// not parseable as JSON — return original
	}
	return raw;
}

// ============================================================================
// BeforeLoopManager
// ============================================================================

export class BeforeLoopManager {
	#modelRegistry: ModelRegistry;
	#settings: Settings;
	#workspace: string;
	#swarmDir: string;
	#yamlPath: string;
	#stateTracker: StateTracker;
	#activityLogger: ActivityLogger;
	#experienceStore: ExperienceStore;
	#runManager: RunManager;

	#conversation: ConversationTurn[] = [];
	#taskDescription = "";
	#phase: LoopPhase = "idle";
	#busy = false;
	#planReady = false;
	#planMtime = 0;
	/** OH-MY-PI SessionManager for session.jsonl persistence. */
	#sessionManager: SwarmSessionManager | null = null;

	constructor(opts: {
		modelRegistry: ModelRegistry;
		settings: Settings;
		workspace: string;
		swarmDir: string;
		yamlPath: string;
		stateTracker: StateTracker;
		activityLogger: ActivityLogger;
		experienceStore: ExperienceStore;
		runManager: RunManager;
	}) {
		this.#modelRegistry = opts.modelRegistry;
		this.#settings = opts.settings;
		this.#workspace = opts.workspace;
		this.#swarmDir = opts.swarmDir;
		this.#yamlPath = opts.yamlPath;
		this.#stateTracker = opts.stateTracker;
		this.#activityLogger = opts.activityLogger;
		this.#experienceStore = opts.experienceStore;
		this.#runManager = opts.runManager;
	}

	/**
	 * Persist current conversation snapshot to session.jsonl via
	 * SwarmSessionManager. Called after every conversation mutation.
	 */
	async #saveConversation(): Promise<void> {
		try {
			this.#sessionManager?.logConversationSnapshot(this.#conversation);
		} catch (err) {
			logger.warn("Failed to save conversation history", { error: String(err) });
		}
	}

	/**
	 * Public accessor: returns a shallow copy of the conversation history.
	 * Used by the API endpoint GET /api/before-loop/history.
	 */
	getHistory(): ConversationTurn[] {
		return [...this.#conversation];
	}

	/**
	 * Inject a SwarmSessionManager for dual-write persistence.
	 * When set, conversation turns are also written to session.jsonl.
	 */
	setSessionManager(sm: SwarmSessionManager): void {
		this.#sessionManager = sm;
	}

	get isBusy(): boolean {
		return this.#busy;
	}

	getState(): BeforeLoopState {
		return {
			phase: this.#phase,
			task: this.#taskDescription,
			conversationLength: this.#conversation.length,
			planReady: this.#planReady,
			busy: this.#busy,
		};
	}

	// ────────────────────────────────────────────────────────────────────────
	// Stage 1: Start — user provides task description, Socrates begins dialogue
	// ────────────────────────────────────────────────────────────────────────

	async start(task: string): Promise<{ success: boolean; error?: string }> {
		if (this.#busy) {
			return { success: false, error: "Socrates is still thinking. Please wait." };
		}
		if (this.#phase !== "idle" && this.#phase !== "after-loop") {
			return { success: false, error: `Before-loop already in progress (phase: ${this.#phase})` };
		}

		// Validate prerequisites BEFORE mutating any state
		// Read loop config for planning prompt
		const loopConfig = await this.#readLoopConfig();
		if (!loopConfig) {
			return { success: false, error: "Failed to parse loop.yaml" };
		}

		this.#taskDescription = task;
		this.#conversation = [];
		this.#planReady = false;
		this.#phase = "before-loop-dialog";
		await this.#setPhase("before-loop-dialog");

		this.#activityLogger.logPhase("before-loop-start");
		this.#activityLogger.logBroadcast("operator", task);

		// Generate planning prompt (queries experience store for past lessons).
		// The full prompt is sent to the LLM but we only persist the user-facing
		// task in the conversation history so the chat UI doesn't leak the
		// SOCRATES_SYSTEM_PROMPT and planning template into the bubble stream.
		await generatePlanningPrompt(
			{ swarmDir: this.#swarmDir, workspace: this.#workspace, loopConfig, taskDescription: task },
			this.#experienceStore,
		);

		this.#conversation.push({ role: "user", content: task });
		await this.#saveConversation();

		// Snapshot plan mtime before Socrates runs
		this.#planMtime = await this.#getPlanMtime();

		// Spawn Socrates in background (non-blocking)
		this.#runSocrates().catch(err => {
			logger.error("Socrates run failed", { error: String(err) });
			this.#activityLogger.logBroadcast("system", `[Error] Socrates failed: ${String(err)}`);
			this.#busy = false;
		});

		return { success: true };
	}

	// ────────────────────────────────────────────────────────────────────────
	// Stage 2: SendMessage — user sends a message, Socrates responds
	// ────────────────────────────────────────────────────────────────────────

	async sendMessage(text: string): Promise<{ success: boolean; error?: string }> {
		if (this.#busy) {
			return { success: false, error: "Socrates is still thinking. Please wait." };
		}
		if (this.#phase !== "before-loop-dialog") {
			return { success: false, error: `Cannot send message in phase: ${this.#phase}` };
		}

		// Log user message immediately (so it shows in chat right away)
		this.#activityLogger.logBroadcast("operator", text);
		this.#conversation.push({ role: "user", content: text });
		await this.#saveConversation();

		// Snapshot plan mtime
		this.#planMtime = await this.#getPlanMtime();

		// Spawn Socrates in background
		this.#runSocrates().catch(err => {
			logger.error("Socrates run failed", { error: String(err) });
			this.#activityLogger.logBroadcast("system", `[Error] Socrates failed: ${String(err)}`);
			this.#busy = false;
		});

		return { success: true };
	}

	// ────────────────────────────────────────────────────────────────────────
	// Stage 3: RunDebate — Cloner Roundtable refines the draft plan
	// ────────────────────────────────────────────────────────────────────────

	async runDebate(): Promise<{ success: boolean; error?: string }> {
		if (this.#busy) {
			return { success: false, error: "Socrates is still thinking. Please wait." };
		}
		if (this.#phase !== "before-loop-dialog" && this.#phase !== "before-loop-confirm") {
			return { success: false, error: `Cannot run debate in phase: ${this.#phase}` };
		}

		this.#phase = "before-loop-debate";
		await this.#setPhase("before-loop-debate");
		this.#activityLogger.logPhase("debate-start");
		this.#activityLogger.logBroadcast("system", "Starting plan debate (Cloner Roundtable)...");

		// Read current draft plan from per-session path
		const planPath = getSessionPlanPath(this.#swarmDir);
		let draftPlan: string;
		try {
			draftPlan = await Bun.file(planPath).text();
		} catch {
			return { success: false, error: "No plan.md found. Ask Socrates to generate one first." };
		}

		const loopConfig = await this.#readLoopConfig();
		if (!loopConfig) {
			return { success: false, error: "Failed to parse loop.yaml" };
		}

		this.#busy = true;

		// Run debate in background (non-blocking)
		(async () => {
			try {
				this.#activityLogger.logBroadcast("system", `${loopConfig.planDebate.clonerCount} cloners will debate over ${loopConfig.planDebate.maxRounds} rounds.`);

				const result = await runPlanDebate(
					draftPlan,
					this.#swarmDir,
					this.#workspace,
					loopConfig,
					this.#modelRegistry,
					this.#settings,
				);

				// Push plan-updated event so frontend PlanViewer auto-refreshes
				this.#activityLogger.logPhase("plan-updated");
				this.#planReady = true;

				this.#activityLogger.logPhase("debate-done");
				this.#activityLogger.logBroadcast(
					"system",
					`Plan debate ${result.converged ? "converged" : "completed"} (${result.refined ? "refined" : "unchanged"}). Review the plan and click "Confirm & Start" to begin.`,
				);

				this.#phase = "before-loop-confirm";
				await this.#setPhase("before-loop-confirm");
			} catch (err) {
				logger.error("Plan debate failed", { error: String(err) });
				this.#activityLogger.logBroadcast("system", `[Error] Debate failed: ${String(err)}`);
				this.#phase = "before-loop-dialog";
				await this.#setPhase("before-loop-dialog");
			} finally {
				this.#busy = false;
			}
		})();

		return { success: true };
	}

	// ────────────────────────────────────────────────────────────────────────
	// Stage 4: Confirm — stamp plan.md and start the loop
	// ────────────────────────────────────────────────────────────────────────

	async confirm(): Promise<{ success: boolean; error?: string }> {
		if (this.#busy) {
			return { success: false, error: "Socrates or debate is still running. Please wait." };
		}
		if (this.#phase !== "before-loop-dialog" && this.#phase !== "before-loop-confirm") {
			return { success: false, error: `Cannot confirm in phase: ${this.#phase}` };
		}

		this.#activityLogger.logBroadcast("system", "Plan confirmed. Starting Loop Engineering...");
		this.#phase = "running";
		await this.#setPhase("running");

		// Delegate to RunManager which stamps plan.md and runs the loop
		const result = await this.#runManager.start();

		if (!result.success) {
			// Revert phase on failure
			this.#phase = "before-loop-confirm";
			await this.#setPhase("before-loop-confirm");
			this.#activityLogger.logBroadcast("system", `[Error] Failed to start loop: ${result.error}`);
		}

		return result;
	}

	// ────────────────────────────────────────────────────────────────────────
	// Cancel — abort before-loop and return to idle
	// ────────────────────────────────────────────────────────────────────────

	async cancel(): Promise<{ success: boolean; error?: string }> {
		this.#conversation = [];
		this.#taskDescription = "";
		this.#planReady = false;
		this.#busy = false;
		this.#phase = "idle";
		await this.#setPhase("idle");
		this.#activityLogger.logPhase("before-loop-cancelled");
		this.#activityLogger.logBroadcast("system", "Before Loop cancelled.");
		return { success: true };
	}

	// ────────────────────────────────────────────────────────────────────────
	// Internal: run Socrates agent with full conversation history
	// ────────────────────────────────────────────────────────────────────────

	async #runSocrates(): Promise<void> {
		this.#busy = true;
		const msgId = `socrates-${Date.now()}`;

		try {
			const taskText = this.#buildTaskFromHistory();

			const loopConfig = await this.#readLoopConfig();
			const socratesRestriction = loopConfig?.agentRestrictions?.socrates
				?? loopConfig?.agentRestrictions?.["*"]
				?? SOCRATES_DEFAULT_RESTRICTION;

			const agentDef: AgentDefinition = {
				name: "socrates",
				description: "Before Loop planning agent (Socratic dialogue)",
				systemPrompt: SOCRATES_SYSTEM_PROMPT,
				source: "project" as AgentSource,
			};
			if (socratesRestriction.allowed && socratesRestriction.allowed.length > 0) {
				agentDef.tools = socratesRestriction.allowed;
			}
			if (socratesRestriction.blocked && socratesRestriction.blocked.length > 0) {
				agentDef.blockedTools = socratesRestriction.blocked;
			}
			if (socratesRestriction.write_allowlist && socratesRestriction.write_allowlist.length > 0) {
				agentDef.writeAllowList = socratesRestriction.write_allowlist;
			}

			const result = await streamAgentOutput(
				{
					activityLogger: this.#activityLogger,
					msgId,
					from: "socrates",
					transformOutput: parseSocratesResponse,
				},
				{
					cwd: this.#stateTracker.swarmDir,
					agent: agentDef,
					task: taskText,
					index: 0,
					id: `socrates-${Date.now()}`,
					modelRegistry: this.#modelRegistry,
					settings: this.#settings,
					enableLsp: false,
					keepAlive: false,
					modelOverride: loopConfig?.model ?? undefined,
				},
			);

			const displayOutput = result.output || "(no output)";

			this.#conversation.push({ role: "assistant", content: displayOutput });
			await this.#saveConversation();

			const newMtime = await this.#getPlanMtime();
			if (newMtime > this.#planMtime) {
				this.#planReady = true;
				this.#planMtime = newMtime;
				this.#activityLogger.logPhase("plan-updated");
				this.#activityLogger.logBroadcast(
					"system",
					"Draft plan.md is ready. Click 'Run Debate' to refine it, or 'Confirm & Start' to proceed.",
				);
			}
		} catch (err) {
			throw err;
		} finally {
			this.#busy = false;
		}
	}

	// ────────────────────────────────────────────────────────────────────────
	// Internal: build task text from conversation history
	// ────────────────────────────────────────────────────────────────────────

	#buildTaskFromHistory(): string {
		if (this.#conversation.length === 0) {
			return "No conversation yet.";
		}

		const parts = this.#conversation.map(turn => {
			const label = turn.role === "user" ? "Human" : "Assistant (You)";
			return `### ${label}\n\n${turn.content}`;
		});

		return [
			"## Conversation History",
			"",
			"Below is the full conversation so far. Respond to the LATEST Human message.",
			"If you now have enough information, write the plan to .omp/plan.md and summarize it.",
			"",
			parts.join("\n\n---\n\n"),
		].join("\n");
	}

	// ────────────────────────────────────────────────────────────────────────
	// Internal: helpers
	// ────────────────────────────────────────────────────────────────────────

	async #setPhase(phase: LoopPhase): Promise<void> {
		await this.#stateTracker.updatePipeline({ loopPhase: phase });
	}

	async #readLoopConfig(): Promise<LoopSwarmConfig | null> {
		try {
			const content = await fs.readFile(this.#yamlPath, "utf-8");
			const def = parseSwarmYaml(content);
			const errors = validateSwarmDefinition(def);
			if (errors.length > 0) {
				logger.error("YAML validation errors", { errors });
				return null;
			}
			return def.loopConfig ?? null;
		} catch (err) {
			logger.error("Failed to read loop config", { error: String(err) });
			return null;
		}
	}

	async #getPlanMtime(): Promise<number> {
		try {
			const stat = await fs.stat(getSessionPlanPath(this.#swarmDir));
			return stat.mtimeMs;
		} catch {
			return 0;
		}
	}
}
