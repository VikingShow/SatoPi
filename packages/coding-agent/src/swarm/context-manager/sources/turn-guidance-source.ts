/**
 * TurnGuidanceSource — Injects turn-based guidance during the Script phase.
 *
 * Priority: 3.
 * Applies to: "script" phase only.
 *
 * Pure logic with no external dependencies. Based on the turn number,
 * injects different guidance to the agent:
 *   - Turn 1: ask clarifying questions, gather requirements
 *   - Turns 2-4: confirm decisions progressively
 *   - Turn 5+: wrap up, summarize, prepare for confirmation
 */

import type { Chapter } from "../../core/state";
import type { AgentSpecLike, BuildContext, ContextFragment, ContextSource } from "../context-pipeline";

export class TurnGuidanceSource implements ContextSource {
	readonly name = "turn-guidance";
	readonly priority = 3;

	appliesTo(phase: Chapter, _agentRole: string): boolean {
		return phase === "script";
	}

	async build(_spec: AgentSpecLike, base: BuildContext): Promise<ContextFragment> {
		const turn = base.turnNumber;

		let guidance: string;

		if (turn <= 1) {
			guidance = [
				"## Turn Guidance: First Turn",
				"",
				"This is the initial turn of the Script phase. Your task:",
				"- Ask clarifying questions to understand the user's goals",
				"- Identify constraints, requirements, and acceptance criteria",
				"- Do NOT jump to solutions — focus on discovery",
				"- Engage in Socratic dialogue: one question at a time",
				"- Surface hidden assumptions and risks",
			].join("\n");
		} else if (turn <= 4) {
			guidance = [
				"## Turn Guidance: Exploration",
				"",
				"You are in the exploration phase. Your task:",
				"- Continue confirming decisions with the user",
				"- Begin drafting sections of plan.md as decisions are confirmed",
				"- Probe for edge cases and non-functional requirements",
				"- Estimate agent-hours and team composition",
				"- Maintain a collaborative, patient tone",
			].join("\n");
		} else {
			guidance = [
				"## Turn Guidance: Wrap-Up",
				"",
				"You are approaching the end of the Script phase. Your task:",
				"- Summarize all confirmed decisions",
				"- Ensure plan.md is complete with clear acceptance criteria",
				"- Propose a final agent-hour estimate and team composition",
				"- Ask if the user is ready to proceed to the Stage phase",
				"- Flag any unresolved questions or risks",
			].join("\n");
		}

		return {
			taskPromptAddition: guidance,
		};
	}
}
