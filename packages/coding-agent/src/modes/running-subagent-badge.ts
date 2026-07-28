import { AgentRegistry } from "../registry/agent-registry";

export interface RunningSubagentRegistrySource {
	agentRegistry: AgentRegistry;
}

export function getRunningSubagentBadgeRegistry(collabGuest: RunningSubagentRegistrySource | undefined): AgentRegistry {
	return collabGuest?.agentRegistry ?? AgentRegistry.global();
}

export function countRunningSubagentBadgeAgents(registry: AgentRegistry): number {
	return registry.list().filter(ref => ref.kind !== "main" && ref.kind !== "advisor" && ref.status === "running")
		.length;
}

export function countRunningPersistentAgents(registry: AgentRegistry): number {
	return registry.list().filter(ref => ref.kind === "persistent" && ref.status === "running").length;
}
