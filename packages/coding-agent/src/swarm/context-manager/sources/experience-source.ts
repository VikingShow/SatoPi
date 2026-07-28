/**
 * ExperienceSource — Recalls relevant lessons from ExperienceStore.
 *
 * Priority: 2.
 * Applies to: "script" and "script-debate" phases — experience is most useful
 *   during planning and debate, when past lessons inform architectural decisions.
 *
 * Searches the experience store for lessons matching the task description,
 * formats them as user messages injected into the conversation history.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { Chapter } from "../../core/state";
import type { ExperienceStore } from "../../curtain/experience";
import type { AgentSpecLike, BuildContext, ContextFragment, ContextSource } from "../context-pipeline";

export class ExperienceSource implements ContextSource {
	readonly name = "experience";
	readonly priority = 2;

	readonly #experienceStore: ExperienceStore;

	constructor(experienceStore: ExperienceStore) {
		this.#experienceStore = experienceStore;
	}

	appliesTo(phase: Chapter, _agentRole: string): boolean {
		return phase === "script" || phase === "script-debate" || phase === "stage";
	}

	async build(spec: AgentSpecLike, base: BuildContext): Promise<ContextFragment> {
		try {
			const results = this.#experienceStore.search(base.taskDescription, 5);
			if (results.length === 0) {
				return {};
			}

			const lessonsText = results
				.map(
					(r, i) =>
						`[Lesson ${i + 1}] (${r.lesson.type}, confidence: ${r.lesson.confidence})\n${r.lesson.summary}\n${r.lesson.detail.slice(0, 500)}`,
				)
				.join("\n\n---\n\n");

			const injectedMessage = {
				role: "user" as const,
				timestamp: Date.now(),
				content: [
					"<past_experience>",
					`The following ${results.length} relevant lessons were recalled from past runs for task: "${base.taskDescription}"`,
					"",
					lessonsText,
					"</past_experience>",
				].join("\n"),
			};

			return {
				injectedMessages: [injectedMessage],
			};
		} catch (err) {
			logger.warn("[ExperienceSource] Failed to search experience store", {
				error: String(err),
				agentId: spec.id,
				task: base.taskDescription,
			});
			return {};
		}
	}
}
