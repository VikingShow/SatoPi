/**
 * PeerRosterSource — Injects the current peer roster into agent context.
 *
 * Priority: 8.
 * Applies to: all phases, all agent roles.
 *
 * Reads the AgentRegistry (the process-global singleton by default, or an
 * injected instance for test isolation) and renders a compact <peer_roster>
 * XML block: id, displayName, role, status — so crew/graph agents know who
 * they are collaborating with. The agent itself is excluded, advisor refs
 * are never peers (observability-only transcripts), and the list is capped
 * (default 32) to bound tokens.
 *
 * Crew members are covered implicitly: every crew agent is a registered
 * AgentRegistry ref, and at this baseline there is no exported "active crew"
 * accessor on CrewManager to consult, so the registry is the roster.
 */

import { type AgentRef, AgentRegistry } from "../../registry/agent-registry";
import type { Chapter } from "../../swarm/core/state";
import type { AgentSpecLike, BuildContext, ContextFragment, ContextSource } from "../context-pipeline";

/** Default cap on roster entries — bounds token cost regardless of registry size. */
export const DEFAULT_PEER_ROSTER_CAP = 32;

/** Escape a string for use inside an XML attribute value. */
function escapeXml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export class PeerRosterSource implements ContextSource {
	readonly name = "peer-roster";
	readonly priority = 8;

	readonly #registry: AgentRegistry;
	readonly #cap: number;

	constructor(registry: AgentRegistry = AgentRegistry.global(), opts?: { cap?: number }) {
		this.#registry = registry;
		this.#cap = opts?.cap ?? DEFAULT_PEER_ROSTER_CAP;
	}

	appliesTo(_phase: Chapter, _agentRole: string): boolean {
		return true;
	}

	async build(spec: AgentSpecLike, _base: BuildContext): Promise<ContextFragment> {
		const peers = this.#registry
			.list()
			.filter(ref => ref.id !== spec.id && ref.kind !== "advisor")
			.sort((a, b) => a.id.localeCompare(b.id));

		const lines: string[] = ["<peer_roster>"];

		if (peers.length === 0) {
			lines.push("  No peers currently registered.");
			lines.push("</peer_roster>");
			return { systemPromptAddition: lines.join("\n") };
		}

		const shown = peers.slice(0, this.#cap);
		const countNote =
			shown.length === 1
				? "You are collaborating with 1 other agent"
				: `You are collaborating with ${shown.length} other agents`;
		lines.push(`  ${countNote}`);
		for (const ref of shown) {
			lines.push(`    ${formatPeer(ref)}`);
		}
		if (peers.length > this.#cap) {
			lines.push(`    ... and ${peers.length - this.#cap} more`);
		}
		lines.push("</peer_roster>");

		return {
			systemPromptAddition: lines.join("\n"),
		};
	}
}

/** Render a single peer ref as a self-closing <peer> element. */
function formatPeer(ref: AgentRef): string {
	const attrs = [`id="${escapeXml(ref.id)}"`, `name="${escapeXml(ref.displayName)}"`];
	if (ref.role) {
		attrs.push(`role="${escapeXml(ref.role)}"`);
	}
	attrs.push(`status="${escapeXml(ref.status)}"`);
	return `<peer ${attrs.join(" ")} />`;
}
