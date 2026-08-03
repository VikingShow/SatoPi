/**
 * Session switcher — Switch main transcript view to a different agent.
 *
 * When user selects an agent from the sidebar or types /switch <agent-id>,
 * the main transcript view should show that agent's conversation.
 */

import type { AgentRegistry } from "../registry/agent-registry";
import type { SessionFocusController } from "./controllers/session-focus-controller";

/**
 * Switch the visible transcript to a different agent.
 * Uses the SessionFocusController to retarget the view.
 * Returns true if the switch was successful.
 */
export async function switchToAgent(
	registry: AgentRegistry,
	focusController: SessionFocusController,
	agentId: string,
): Promise<boolean> {
	const ref = registry.get(agentId);
	if (!ref) return false;
	try {
		await focusController.focusAgent(agentId);
		return true;
	} catch {
		return false;
	}
}

export function listSwitchableAgents(registry: AgentRegistry): Array<{ id: string; name: string; status: string }> {
	return registry
		.list()
		.filter(ref => ref.kind !== "advisor")
		.map(ref => ({ id: ref.id, name: ref.displayName, status: ref.status }));
}

// ── Agent notification tracking ───────────────────────────────────────────

/**
 * Tracks unseen output on non-focused agents.
 * When an agent produces output while not visible, a notification dot
 * appears in the sidebar.
 */
export class AgentNotificationTracker {
	#unseenActivity = new Set<string>();
	#focusedAgentId: string | undefined;

	/** Record activity on an agent. If not currently focused, mark as unseen. */
	recordActivity(agentId: string): void {
		if (agentId === this.#focusedAgentId) return;
		this.#unseenActivity.add(agentId);
	}

	/** Set the currently focused agent. Clears unseen flag for that agent. */
	setFocused(agentId: string | undefined): void {
		this.#focusedAgentId = agentId;
		if (agentId) this.#unseenActivity.delete(agentId);
	}

	/** Check if an agent has unseen activity. */
	hasUnseen(agentId: string): boolean {
		return this.#unseenActivity.has(agentId);
	}

	/** Clear all unseen notifications. */
	clear(): void {
		this.#unseenActivity.clear();
	}

	/** Get all agent IDs with unseen activity for status line display. */
	getUnseenAgentIds(): string[] {
		return [...this.#unseenActivity];
	}
}
