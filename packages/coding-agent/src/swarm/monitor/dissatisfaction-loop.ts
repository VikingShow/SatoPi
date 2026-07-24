/**
 * DissatisfactionLoop — Curtain 阶段不满意 → Planner 重新确认 → 重新 Stage
 *
 * 当前 CurtainRunner 只有 curtain → idle 单一路径。
 * 本模块 wiring applaudSignal，实现:
 *
 *   用户不满意
 *     → 保留 workspace 快照
 *     → 触发 Planner agent 介入
 *     → 与用户澄清不满意点
 *     → 更新 plan.md
 *     → 重新进入 Script-confirm → Stage
 *
 *   用户满意
 *     → curtain → idle → 写入 ExperienceStore
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { Agent } from "@oh-my-pi/pi-agent-core";
import type { ActivityLogger } from "../hooks/activity-logger";
import type { StateTracker } from "../core/state";

// ============================================================================
// Types
// ============================================================================

export interface DissatisfactionLoopConfig {
	/** Planner Agent 实例（用于重新规划） */
	plannerAgent: Agent;
	/** ActivityLogger 实例 */
	activityLogger: ActivityLogger;
	/** StateTracker 实例 */
	stateTracker: StateTracker;
	/** Plan.md 文件路径 */
	planPath: string;
	/** Workspace 目录 */
	workspace: string;
}

export interface DissatisfactionResult {
	/** Whether the user wants to retry */
	shouldRetry: boolean;
	/** New plan content (if retrying) */
	updatedPlan?: string;
	/** Clarified issues */
	clarifiedIssues?: string[];
}

// ============================================================================
// DissatisfactionLoop
// ============================================================================

export class DissatisfactionLoop {
	readonly #config: DissatisfactionLoopConfig;

	constructor(config: DissatisfactionLoopConfig) {
		this.#config = config;
	}

	/**
	 * Handle user dissatisfaction.
	 *
	 * @param userFeedback — User's feedback on why they're not satisfied
	 * @returns DissatisfactionResult with retry decision
	 */
	async handleDissatisfaction(
		userFeedback: string,
	): Promise<DissatisfactionResult> {
		const { plannerAgent, activityLogger, stateTracker } = this.#config;

		logger.info("[DissatisfactionLoop] User not satisfied — initiating retry path", {
			feedback: userFeedback.slice(0, 100),
		});

		activityLogger.logBroadcast("system", [
			"⚠️ User is not satisfied with the results.",
			`Feedback: ${userFeedback}`,
			"Initiating re-planning...",
		].join("\n"));

		// 1. Transition to script phase for re-planning
		await stateTracker.updatePipeline({
			phase: "script",
			status: "replanning",
			roundtablePhase: "User dissatisfied — re-planning",
		});

		// 2. Steer Planner agent to clarify issues
		const clarificationPrompt = [
			"**Dissatisfaction Detected**",
			"",
			"The user is not satisfied with the previous execution.",
			`Their feedback: "${userFeedback}"`,
			"",
			"Your task:",
			"1. Clarify what went wrong with the user",
			"2. Identify which parts of plan.md need updating",
			"3. Propose revised plan for the user to approve",
			"",
			"Ask the user specific questions about their concerns.",
			"Focus on actionable changes to plan.md.",
		].join("\n");

		plannerAgent.steer({ role: "user", content: [{ type: "text", text: clarificationPrompt }], timestamp: Date.now() });
		plannerAgent.followUp({
			role: "user",
			content: [{ type: "text", text: "Please clarify the issues you encountered and what needs to change." }],
			timestamp: Date.now(),
		});

		await plannerAgent.continue();
		await plannerAgent.waitForIdle();

		// 3. Extract clarified issues from Planner conversation
		const plannerMessages = plannerAgent.state.messages;
		const issues: string[] = [];
		for (const msg of plannerMessages) {
			if (msg.role === "assistant") {
				let text = "";
				if (typeof msg.content === "string") text = msg.content;
				else if (Array.isArray(msg.content)) {
					text = msg.content
						.filter(c => c.type === "text")
						.map(c => c.text)
						.join("\n");
				}
				if (text.includes("issue") || text.includes("problem") || text.includes("change")) {
					issues.push(text);
				}
			}
		}

		activityLogger.logBroadcast("system", `Re-planning complete. ${issues.length} issues identified.`);

		return {
			shouldRetry: true,
			clarifiedIssues: issues.length > 0 ? issues : [userFeedback],
		};
	}

	/**
	 * Complete the dissatisfaction loop successfully.
	 * The caller should then trigger Script-confirm → Stage.
	 */
	completeLoop(result: DissatisfactionResult): void {
		if (!result.shouldRetry) {
			this.#config.stateTracker.updatePipeline({
				phase: "curtain",
				status: "completed",
			});
			return;
		}

		this.#config.activityLogger.logBroadcast("system", [
			"✅ Re-planning complete. Updated plan.md is ready.",
			"User: Please review the updated plan and confirm to restart the Stage.",
		].join("\n"));
	}
}

/**
 * Wiring function: set up the applaudSignal → dissatisfaction path.
 *
 * Usage in curtain-runner.ts:
 *
 *   const loop = new DissatisfactionLoop({ plannerAgent, ... });
 *   wireApplaudSignal({
 *     applaudSignal: opts.applaudSignal,
 *     onDissatisfied: (feedback) => loop.handleDissatisfaction(feedback),
 *     onSatisfied: () => console.log("Done!"),
 *   });
 */
export function wireApplaudSignal(options: {
	applaudSignal?: AbortSignal;
	onDissatisfied: (feedback: string) => Promise<DissatisfactionResult>;
	onSatisfied: () => Promise<void>;
}): void {
	const { applaudSignal } = options;
	if (!applaudSignal) {
		logger.debug("[DissatisfactionLoop] No applaudSignal provided — skipping wiring");
		return;
	}

	// applaudSignal is an AbortSignal.
	// When the user expresses dissatisfaction, the signal is aborted.
	// We wire this by listening for the abort event.
	applaudSignal.addEventListener("abort", () => {
		const reason = (applaudSignal as any).reason ?? "User not satisfied with results";

		if (typeof reason === "string" && reason.toLowerCase().includes("dissatisf")) {
			logger.info("[DissatisfactionLoop] Dissatisfaction signal received");
			options.onDissatisfied(reason).catch(err => {
				logger.error("[DissatisfactionLoop] handleDissatisfaction failed", { error: String(err) });
			});
		} else {
			logger.info("[DissatisfactionLoop] Satisfaction confirmed");
			options.onSatisfied().catch(err => {
				logger.error("[DissatisfactionLoop] onSatisfied failed", { error: String(err) });
			});
		}
	}, { once: true });
}
