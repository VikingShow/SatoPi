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

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent";
import type { ModelRegistry, Settings, AgentDefinition, AgentSource } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import type { StateTracker, LoopPhase } from "./state";
import type { ActivityLogger } from "./activity-logger";
import type { ExperienceStore } from "./after-loop/experience";
import type { RunManager } from "./monitor/api-routes";
import { generatePlanningPrompt, runPlanDebate } from "./before-loop";
import { parseSwarmYaml, validateSwarmDefinition, type LoopSwarmConfig, type AgentToolRestriction } from "./schema";

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

// ============================================================================
// Socrates system prompt
// ============================================================================

const SOCRATES_SYSTEM_PROMPT = `You are Socrates, a planning assistant for the Loop Engineering system.

Your role is to help the human clarify their task through Socratic dialogue:
1. Ask probing questions to understand goals, constraints, and acceptance criteria
2. Help identify potential risks, edge cases, and non-obvious requirements
3. Once you have sufficient clarity, write a plan to .omp/plan.md

Guidelines:
- Be concise but thorough. Ask one or two focused questions at a time.
- When you have enough information, write the plan using the write_file tool to .omp/plan.md
- The plan should include: what to build/achieve, constraints, non-goals, acceptance criteria, suggested approach
- After writing the plan, briefly summarize it in your response and tell the human the plan is ready
- You have access to read, write_file, grep, find, and glob tools (no bash/shell execution, no edit)
- If the human's initial description is vague, ask for clarification before planning
- If the human asks you to modify the plan, update .omp/plan.md accordingly

Important: You are in a multi-turn conversation. The full conversation history is provided below.
Respond to the LATEST human message. If no new human message, respond to the initial planning prompt.`;

/**
 * Default tool restriction for Socrates — read + write_file (for plan.md) + grep + find.
 * No bash/shell execution, no edit. Can be overridden via agent_restrictions.socrates in YAML.
 */
const SOCRATES_DEFAULT_RESTRICTION: AgentToolRestriction = {
	allowed: ["read", "write_file", "grep", "find", "glob"],
};

// ============================================================================
// BeforeLoopManager
// ============================================================================

export class BeforeLoopManager {
	#modelRegistry: ModelRegistry;
	#settings: Settings;
	#workspace: string;
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

	constructor(opts: {
		modelRegistry: ModelRegistry;
		settings: Settings;
		workspace: string;
		yamlPath: string;
		stateTracker: StateTracker;
		activityLogger: ActivityLogger;
		experienceStore: ExperienceStore;
		runManager: RunManager;
	}) {
		this.#modelRegistry = opts.modelRegistry;
		this.#settings = opts.settings;
		this.#workspace = opts.workspace;
		this.#yamlPath = opts.yamlPath;
		this.#stateTracker = opts.stateTracker;
		this.#activityLogger = opts.activityLogger;
		this.#experienceStore = opts.experienceStore;
		this.#runManager = opts.runManager;
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

		this.#taskDescription = task;
		this.#conversation = [];
		this.#planReady = false;
		this.#phase = "before-loop-dialog";
		await this.#setPhase("before-loop-dialog");

		this.#activityLogger.logPhase("before-loop-start");
		this.#activityLogger.logBroadcast("operator", task);

		// Read loop config for planning prompt
		const loopConfig = await this.#readLoopConfig();
		if (!loopConfig) {
			return { success: false, error: "Failed to parse loop.yaml" };
		}

		// Generate planning prompt (queries experience store for past lessons)
		const prompt = await generatePlanningPrompt(
			{ workspace: this.#workspace, loopConfig, taskDescription: task },
			this.#experienceStore,
		);

		this.#conversation.push({ role: "user", content: prompt });

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

		// Read current draft plan
		const planPath = path.join(this.#workspace, ".omp", "plan.md");
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
		this.#activityLogger.logBroadcast("system", "Socrates is thinking...");

		try {
			// Build task text from full conversation history
			const taskText = this.#buildTaskFromHistory();

			// Resolve tool restrictions: use agent_restrictions.socrates from YAML if present,
			// otherwise fall back to the default read-only planning restriction.
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

			const result = await runSubprocess({
				cwd: this.#workspace,
				agent: agentDef,
				task: taskText,
				index: 0,
				id: `socrates-${Date.now()}`,
				modelRegistry: this.#modelRegistry,
				settings: this.#settings,
				enableLsp: false,
				keepAlive: false,
			});

			const output = result.output || "(no output)";

			// Add to conversation history
			this.#conversation.push({ role: "assistant", content: output });

			// Push Socrates response to frontend via SSE
			this.#activityLogger.logBroadcast("socrates", output);

			// Check if plan.md was written or updated during this run
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
			const errMsg = err instanceof Error ? err.message : String(err);
			this.#activityLogger.logBroadcast("system", `[Error] Socrates failed: ${errMsg}`);
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
			const stat = await fs.stat(path.join(this.#workspace, ".omp", "plan.md"));
			return stat.mtimeMs;
		} catch {
			return 0;
		}
	}
}
