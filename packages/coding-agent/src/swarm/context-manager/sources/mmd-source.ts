/**
 * MmdSource — Injects Mermaid Diagram context at agent creation time.
 *
 * Priority: 3 (between ExperienceSource=2 and StigmergySource=4).
 * Applies to: all phases.
 *
 * Previously this was done per-turn inside AgentLauncher's custom
 * transformContext. Moving it here means it's injected once at creation
 * time via ContextPipeline.assemble() → assembledContext.injectedMessages.
 */
import type { Chapter } from "../../core/state";
import type { AgentSpecLike, BuildContext, ContextFragment, ContextSource } from "../context-pipeline";

export class MmdSource implements ContextSource {
	readonly name = "mmd";
	readonly priority = 3;

	readonly #activeMmd: string | null;

	/**
	 * @param activeMmd — MMD content string, or null to disable injection.
	 */
	constructor(activeMmd: string | null = null) {
		this.#activeMmd = activeMmd;
	}

	appliesTo(_phase: Chapter, _agentRole: string): boolean {
		return this.#activeMmd !== null && this.#activeMmd.length > 0;
	}

	async build(_spec: AgentSpecLike, _base: BuildContext): Promise<ContextFragment> {
		if (!this.#activeMmd) {
			return {};
		}

		return {
			injectedMessages: [
				{
					role: "user" as const,
					timestamp: Date.now(),
					content: this.#activeMmd,
				},
			],
		};
	}
}
