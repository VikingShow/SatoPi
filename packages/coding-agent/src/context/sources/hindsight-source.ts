/**
 * HindsightSource — Recalls cross-session memories from the remote Hindsight bank.
 *
 * Priority: 8 (injected after local sources 0..7).
 * Applies to: all phases (but only active if a Hindsight client is configured).
 *
 * Mirrors MnemopiSource: performs a bounded, fail-soft semantic recall against
 * the remote bank and injects the results as a user message so the agent can
 * reference lessons learned in prior sessions/runs.
 *
 * Robustness: recall is a network call, so it is wrapped in a short timeout —
 * planning must not stall on a slow/unreachable Hindsight server. Any failure
 * (timeout, network, unconfigured) yields an empty fragment.
 */

import { logger } from "@satopi/pi-utils";
import type { Chapter } from "../../swarm/core/state";
import type { SwarmHindsightClient } from "../../swarm/infra/hindsight-adapter";
import type { AgentSpecLike, BuildContext, ContextFragment, ContextSource } from "../context-pipeline";

/** Max time to wait on a recall before giving up and injecting nothing. */
const RECALL_TIMEOUT_MS = 3_000;

export class HindsightSource implements ContextSource {
	readonly name = "hindsight";
	readonly priority = 8;

	readonly #client: SwarmHindsightClient | null;

	constructor(client: SwarmHindsightClient | null = null) {
		this.#client = client;
	}

	appliesTo(_phase: Chapter, _agentRole: string): boolean {
		return this.#client !== null;
	}

	async build(_spec: AgentSpecLike, base: BuildContext): Promise<ContextFragment> {
		if (!this.#client) {
			return {};
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
		try {
			const items = await this.#client.recall(base.taskDescription, { signal: controller.signal });
			if (items.length === 0) {
				return {};
			}

			const memoriesText = items
				.map((item, i) => {
					const label = item.type ? `[Memory ${i + 1}] (${item.type})` : `[Memory ${i + 1}]`;
					return `${label} ${item.text.slice(0, 500)}`;
				})
				.join("\n");

			const injectedMessage = {
				role: "user" as const,
				timestamp: Date.now(),
				content: [
					"<hindsight_memories>",
					`Recalled ${items.length} cross-session memories for task: "${base.taskDescription}"`,
					"",
					memoriesText,
					"</hindsight_memories>",
				].join("\n"),
			};

			return { injectedMessages: [injectedMessage] };
		} catch (err) {
			logger.warn("[HindsightSource] recall failed", {
				error: String(err),
				task: base.taskDescription,
			});
			return {};
		} finally {
			clearTimeout(timer);
		}
	}
}
