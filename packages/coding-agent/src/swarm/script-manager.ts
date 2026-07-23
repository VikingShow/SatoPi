/**
 * ScriptManager — Manages the Script (planning) phase.
 *
 * Data flow:
 *   1. start(task, agentId) → spawn selected agent (role=planner) → SSE → ChatView
 *   2. sendMessage(text) → user msg via SSE → spawn agent with full history → SSE
 *   3. runDebate() → multiple agents debate → refined plan.md → plan-updated event
 *   4. confirm() → SwarmRunManager.start() → phase becomes "stage"
 *
 * Each stage updates StateTracker.phase so the frontend can react.
 * All agent output is pushed to the frontend via ActivityLogger → SSE.
 */

import * as fs from "node:fs/promises";
import type { ModelRegistry, Settings, AgentDefinition, AgentSource } from "@oh-my-pi/pi-coding-agent";
import { logger } from "@oh-my-pi/pi-utils";
import type { StateTracker, Chapter } from "./state";
import type { ActivityLogger } from "./activity-logger";
import type { ExperienceStore } from "./curtain/experience";
import type { RunManager } from "./monitor/api-routes";
import type { SwarmSessionManager } from "./swarm-session-manager";
import type { ProfileRegistry } from "./agent-profile";
import type { RoleAssetManager } from "./role-asset";
import { generatePlanningPrompt, runPlanDebate } from "./script-planner";
import { streamAgentOutput } from "./streaming";
import { getSessionPlanPath } from "./plan-paths";
import { parseSwarmYaml, validateSwarmDefinition, type LoopSwarmConfig } from "./schema";

// ============================================================================
// Types
// ============================================================================

export interface ScriptState {
	phase: Chapter;
	task: string;
	conversationLength: number;
	planReady: boolean;
	busy: boolean;
	selectedAgentId?: string;
	recommendedAgents?: number;
	estimatedAgentHours?: number;
}

interface ConversationTurn {
	role: "user" | "assistant";
	content: string;
}

// ============================================================================
// ScriptManager
// ============================================================================

export class ScriptManager {
	#modelRegistry: ModelRegistry;
	#settings: Settings;
	#workspace: string;
	#swarmDir: string;
	#yamlPath: string;
	#stateTracker: StateTracker;
	#activityLogger: ActivityLogger;
	#experienceStore: ExperienceStore;
	#runManager: RunManager;
	#profileRegistry?: ProfileRegistry;
	#roleAssetManager?: RoleAssetManager;

	#conversation: ConversationTurn[] = [];
	#taskDescription = "";
	#phase: Chapter = "idle";
	#busy = false;
	#planReady = false;
	#planMtime = 0;
	#selectedAgentId: string | undefined;
	#recommendedAgents: number | undefined;
	#estimatedAgentHours: number | undefined;
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
		profileRegistry?: ProfileRegistry;
		roleAssetManager?: RoleAssetManager;
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
		this.#profileRegistry = opts.profileRegistry;
		this.#roleAssetManager = opts.roleAssetManager;
	}

	async #saveConversation(): Promise<void> {
		try { this.#sessionManager?.logConversationSnapshot(this.#conversation); }
		catch (err) { logger.warn("Failed to save conversation history", { error: String(err) }); }
	}

	getHistory(): ConversationTurn[] { return [...this.#conversation]; }
	setSessionManager(sm: SwarmSessionManager): void { this.#sessionManager = sm; }
	get isBusy(): boolean { return this.#busy; }

	getState(): ScriptState {
		return {
			phase: this.#phase,
			task: this.#taskDescription,
			conversationLength: this.#conversation.length,
			planReady: this.#planReady,
			busy: this.#busy,
			selectedAgentId: this.#selectedAgentId,
			recommendedAgents: this.#recommendedAgents,
			estimatedAgentHours: this.#estimatedAgentHours,
		};
	}

	async start(task: string, agentId?: string): Promise<{ success: boolean; error?: string }> {
		if (this.#busy) return { success: false, error: "An agent is still thinking. Please wait." };
		if (this.#phase !== "idle" && this.#phase !== "curtain") {
			return { success: false, error: `Script phase already in progress (phase: ${this.#phase})` };
		}

		const loopConfig = await this.#readLoopConfig();
		if (!loopConfig) return { success: false, error: "Failed to parse loop.yaml" };

		this.#taskDescription = task;
		this.#conversation = [];
		this.#planReady = false;
		this.#selectedAgentId = agentId;
		// Register agent profile so Stage can select it later
		if (agentId && this.#profileRegistry) {
			this.#profileRegistry.getOrCreate({
				profileId: agentId,
				name: agentId,
				archetype: "planner",
				description: `Agent created during Script phase planning`,
			});
		}
		this.#recommendedAgents = undefined;
		this.#estimatedAgentHours = undefined;
		this.#phase = "script";
		await this.#setPhase("script");

		this.#activityLogger.logPhase("script-start");
		this.#activityLogger.logBroadcast("human", task);

		await generatePlanningPrompt(
			{ swarmDir: this.#swarmDir, workspace: this.#workspace, loopConfig, taskDescription: task },
			this.#experienceStore,
		);

		this.#conversation.push({ role: "user", content: task });
		await this.#saveConversation();
		this.#planMtime = await this.#getPlanMtime();

		this.#runPlannerAgent().catch(err => {
			logger.error("Planner agent run failed", { error: String(err) });
			this.#activityLogger.logBroadcast("system", `[Error] Planner failed: ${String(err)}`);
			this.#busy = false;
		});

		return { success: true };
	}

	async sendMessage(text: string): Promise<{ success: boolean; error?: string }> {
		if (this.#busy) return { success: false, error: "The planner is still thinking. Please wait." };
		if (this.#phase !== "script") {
			return { success: false, error: `Cannot send message in phase: ${this.#phase}` };
		}
		this.#activityLogger.logBroadcast("human", text);
		this.#conversation.push({ role: "user", content: text });
		await this.#saveConversation();
		this.#planMtime = await this.#getPlanMtime();

		this.#runPlannerAgent().catch(err => {
			logger.error("Planner agent run failed", { error: String(err) });
			this.#activityLogger.logBroadcast("system", `Planner error: ${String(err)}`);
			this.#busy = false;
		});
		return { success: true };
	}

	async runDebate(): Promise<{ success: boolean; error?: string }> {
		if (this.#busy) return { success: false, error: "The planner is still thinking. Please wait." };
		if (this.#phase !== "script" && this.#phase !== "script-confirm") {
			return { success: false, error: `Cannot run debate in phase: ${this.#phase}` };
		}

		this.#phase = "script-debate";
		await this.#setPhase("script-debate");
		this.#activityLogger.logPhase("debate-start");
		this.#activityLogger.logBroadcast("system", "Starting plan debate (agent roundtable)...");

		const planPath = getSessionPlanPath(this.#swarmDir);
		let draftPlan: string;
		try { draftPlan = await Bun.file(planPath).text(); }
		catch { return { success: false, error: "No plan.md found. Ask the planner to generate one first." }; }

		const loopConfig = await this.#readLoopConfig();
		if (!loopConfig) return { success: false, error: "Failed to parse loop.yaml" };

		this.#busy = true;
		(async () => {
			try {
				this.#activityLogger.logBroadcast("system",
					`${loopConfig.planDebate.agentCount} agents will debate over ${loopConfig.planDebate.maxRounds} rounds.`);

				const result = await runPlanDebate(draftPlan, this.#swarmDir, this.#workspace, loopConfig,
					this.#modelRegistry, this.#settings);

				this.#activityLogger.logPhase("plan-updated");
				this.#planReady = true;
				this.#activityLogger.logPhase("debate-done");
				this.#activityLogger.logBroadcast("system",
					`Plan debate ${result.converged ? "converged" : "completed"} (${result.refined ? "refined" : "unchanged"}). Review the plan and click "Confirm & Start" to begin.`);

				this.#phase = "script-confirm";
				await this.#setPhase("script-confirm");
			} catch (err) {
				logger.error("Plan debate failed", { error: String(err) });
				this.#activityLogger.logBroadcast("system", `[Error] Debate failed: ${String(err)}`);
				this.#phase = "script";
				await this.#setPhase("script");
			} finally { this.#busy = false; }
		})();

		return { success: true };
	}

	async confirm(agentCount?: number, reviewerCount?: number): Promise<{ success: boolean; error?: string }> {
		if (this.#busy) return { success: false, error: "Planner or debate is still running. Please wait." };
		if (this.#phase !== "script" && this.#phase !== "script-confirm") {
			return { success: false, error: `Cannot confirm in phase: ${this.#phase}` };
		}

		const estimated = this.#estimatedAgentHours ? ` (estimated ${this.#estimatedAgentHours} agent-hours)` : "";
		this.#activityLogger.logBroadcast("system", `Plan confirmed. Starting Stage execution${estimated}...`);

		this.#phase = "stage";
		await this.#setPhase("stage");

		const result = await this.#runManager.start();
		if (!result.success) {
			this.#phase = "script-confirm";
			await this.#setPhase("script-confirm");
			this.#activityLogger.logBroadcast("system", `Failed to start stage: ${result.error}`);
		}
		return result;
	}

	async cancel(): Promise<{ success: boolean; error?: string }> {
		this.#conversation = [];
		this.#taskDescription = "";
		this.#planReady = false;
		this.#busy = false;
		this.#selectedAgentId = undefined;
		this.#phase = "idle";
		await this.#setPhase("idle");
		this.#activityLogger.logPhase("script-cancelled");
		this.#activityLogger.logBroadcast("system", "Script phase cancelled.");
		return { success: true };
	}

	async #runPlannerAgent(): Promise<void> {
		this.#busy = true;
		const msgId = `planner-${Date.now()}`;
		let planPoll: ReturnType<typeof setInterval> | undefined;

		try {
			const taskText = this.#buildTaskFromHistory();
			const loopConfig = await this.#readLoopConfig();
			const plannerRole = await this.#resolvePlannerRole();
			const systemPrompt = this.#buildPlannerSystemPrompt(plannerRole);

			const agentDef: AgentDefinition = {
				name: this.#selectedAgentId ?? "planner",
				description: "Script phase planning agent",
				systemPrompt,
				source: "project" as AgentSource,
			};
			if (plannerRole?.tools && plannerRole.tools.length > 0) agentDef.tools = plannerRole.tools;

			const planPath = getSessionPlanPath(this.#swarmDir);
			let planFileDetected = false;
			planPoll = setInterval(() => {
				try {
					const file = Bun.file(planPath);
					if (file.size > 0 && !planFileDetected) {
						planFileDetected = true;
						this.#activityLogger.logBroadcast("system",
							"Writing plan.md... The draft will appear in the Plan panel when complete.");
					}
				} catch { /* file not yet created */ }
			}, 500);

			const result = await streamAgentOutput(
				{ activityLogger: this.#activityLogger, msgId, from: this.#selectedAgentId ?? "planner",
					transformOutput: parsePlannerResponse },
				{ cwd: this.#stateTracker.swarmDir, agent: agentDef, task: taskText, index: 0,
					id: `planner-${Date.now()}`, modelRegistry: this.#modelRegistry, settings: this.#settings,
					enableLsp: false, keepAlive: false, modelOverride: loopConfig?.model ?? undefined });

			const displayOutput = result.output || "(no output)";

			const recMatch = displayOutput.match(/Recommended:\s*(\d+)\s*agents?/i);
			if (recMatch) this.#recommendedAgents = parseInt(recMatch[1], 10);
			const hrsMatch = displayOutput.match(/Estimated:\s*(\d+(?:\.\d+)?)\s*agent[- ]hours?/i);
			if (hrsMatch) this.#estimatedAgentHours = parseFloat(hrsMatch[1]);

			this.#conversation.push({ role: "assistant", content: displayOutput });
			await this.#saveConversation();

			const newMtime = await this.#getPlanMtime();
			if (newMtime > this.#planMtime) {
				this.#planReady = true;
				this.#planMtime = newMtime;
				this.#activityLogger.logPhase("plan-updated");
				this.#activityLogger.logBroadcast("system",
					"Plan draft is ready. Open the Plan panel to review. " +
					"Click 'Run Debate' to refine with agent roundtable, or 'Confirm & Start' to begin.");
			}
		} catch (err) { throw err; }
		finally { if (planPoll) clearInterval(planPoll); this.#busy = false; }
	}

	async #resolvePlannerRole(): Promise<{ system: string; guidelines: string[]; tools?: string[] } | null> {
		try {
			const role = await this.#roleAssetManager?.get("planner");
			if (role && role.status === "approved") return { system: role.prompts.system, guidelines: role.prompts.guidelines, tools: role.tools };
		} catch { /* role not found */ }
		return null;
	}

	#buildPlannerSystemPrompt(role: { system: string; guidelines: string[]; tools?: string[] } | null): string {
		const parts: string[] = [];
		if (role) parts.push(role.system);
		else parts.push("You are a Planner agent in the SatoPi system. Help the user clarify goals and produce a comprehensive, executable plan.");
		if (this.#selectedAgentId && this.#profileRegistry) {
			const profileCtx = this.#profileRegistry.getPromptContext(this.#selectedAgentId);
			if (profileCtx) { parts.push(""); parts.push(profileCtx); }
		}
		return parts.join("\n");
	}

	#buildTaskFromHistory(): string {
		if (this.#conversation.length === 0) return "No conversation yet.";
		const parts = this.#conversation.map(turn => {
			const label = turn.role === "user" ? "Human" : "Assistant (You)";
			return `### ${label}\n\n${turn.content}`;
		});
		return [
			"## Conversation History", "",
			"Below is the full conversation so far. Respond to the LATEST Human message.",
			"If you now have enough information, write the plan to .omp/plan.md and summarize it.", "",
			parts.join("\n\n---\n\n"),
		].join("\n");
	}

	async #setPhase(phase: Chapter): Promise<void> { await this.#stateTracker.updatePipeline({ phase }); }

	async #readLoopConfig(): Promise<LoopSwarmConfig | null> {
		try {
			const content = await fs.readFile(this.#yamlPath, "utf-8");
			const def = parseSwarmYaml(content);
			const errors = validateSwarmDefinition(def);
			if (errors.length > 0) { logger.error("YAML validation errors", { errors }); return null; }
			return def.loopConfig ?? null;
		} catch (err) { logger.error("Failed to read loop config", { error: String(err) }); return null; }
	}

	async #getPlanMtime(): Promise<number> {
		try { const stat = await fs.stat(getSessionPlanPath(this.#swarmDir)); return stat.mtimeMs; }
		catch { return 0; }
	}
}

function parsePlannerResponse(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return raw;
	try {
		const obj = JSON.parse(trimmed);
		const textKeys = ["plan", "message", "text", "response", "reply", "content", "answer", "summary"];
		for (const key of textKeys) {
			if (typeof obj?.[key] === "string" && obj[key].length > 0) {
				if (key === "plan" && obj.status === "ready") return "[Plan Ready]\n\n" + obj[key];
				return obj[key];
			}
		}
		if (typeof obj?.error === "string" && obj.error.length > 0) return obj.error;
		if (Array.isArray(obj?.questions) && obj.questions.length > 0) {
			return `Waiting for clarification:\n- ${obj.questions.filter((q: unknown) => typeof q === "string").join("\n- ")}`;
		}
		if (typeof obj?.status === "string") return `(${obj.status})`;
	} catch { /* not parseable */ }
	return raw;
}
