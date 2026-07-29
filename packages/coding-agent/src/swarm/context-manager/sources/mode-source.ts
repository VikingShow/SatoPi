/**
 * ModeContextSource — Injects mode-specific instructions (swarm, standalone, debate).
 *
 * Priority: 0.5 (between role and profile).
 * Applies to: all phases, all agent roles.
 *
 * Mode is inferred from the workflow phase:
 *   - stage → swarm (multi-agent coordination)
 *   - script → one-on-one (human dialogue)
 *   - script-debate → debate (structured discussion)
 *   - curtain, other → standalone (independent work)
 */

import { logger } from "@satopi/pi-utils";
import type { Chapter } from "../../core/state";
import type { AgentSpecLike, BuildContext, ContextFragment, ContextSource } from "../context-pipeline";

const MODE_PROMPTS: Record<string, string> = {
	swarm: [
		"You are part of a SatoPi swarm team. Other agents are working concurrently.",
		"Coordinate your work through file operations and IRC communication.",
		"Check stigmergy marks before editing files to avoid conflicts.",
	].join("\n"),

	standalone: [
		"You are working independently. You have full autonomy over your decisions.",
		"No other agents are working concurrently on this task.",
	].join("\n"),

	debate: [
		"You are participating in a structured debate with other agents.",
		"State your position clearly, consider opposing views, and work toward consensus.",
		"Output your final position as a structured summary when the debate concludes.",
	].join("\n"),

	"one-on-one": [
		"You are in a one-on-one dialogue with a human user.",
		"Ask clarifying questions to understand their requirements.",
		"Summarize your understanding before proceeding to detailed planning.",
	].join("\n"),
};

function resolveMode(phase: Chapter): string {
	switch (phase) {
		case "stage":
			return "swarm";
		case "script":
			return "one-on-one";
		case "script-debate":
			return "debate";
		default:
			return "standalone";
	}
}

export class ModeContextSource implements ContextSource {
	readonly name = "mode";
	readonly priority = 0.5;

	appliesTo(_phase: Chapter, _agentRole: string): boolean {
		return true;
	}

	async build(_spec: AgentSpecLike, base: BuildContext): Promise<ContextFragment> {
		const mode = resolveMode(base.phase.phase);
		const prompt = MODE_PROMPTS[mode];
		if (!prompt) return {};

		logger.debug("[ModeContextSource] Injecting mode context", { mode });
		return { systemPromptAddition: prompt };
	}
}
