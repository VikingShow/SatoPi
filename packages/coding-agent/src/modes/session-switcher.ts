/**
 * Session switcher — Switch main transcript view to a different agent.
 *
 * When user selects an agent from the sidebar or types /switch <agent-id>,
 * the main transcript view should show that agent's conversation.
 *
 * Current implementation: placeholder command that logs the intent.
 * Full integration requires agent-session transcript switching.
 */

import type { AgentRegistry } from "../registry/agent-registry";

export function switchToAgent(registry: AgentRegistry, agentId: string): boolean {
	const ref = registry.get(agentId);
	if (!ref) return false;
	// Future: switch interactive-mode transcript to ref.session
	return true;
}

export function listSwitchableAgents(registry: AgentRegistry): Array<{ id: string; name: string; status: string }> {
	return registry
		.list()
		.filter(ref => ref.kind !== "advisor")
		.map(ref => ({ id: ref.id, name: ref.displayName, status: ref.status }));
}
