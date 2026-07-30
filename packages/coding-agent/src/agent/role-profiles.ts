/**
 * Swarm role profiles — predefined AgentProfiles for common swarm roles.
 * Used by AgentRuntime to map AgentSpec → persistent agent via agent_invoke.
 */
import type { AgentProfile } from "../../agent/agent-profile";

export interface SwarmRoleProfile {
	profileId: string;
	identity: { name: string; archetype: string };
	expertise: { domains: string[]; specialties: string[] };
}

export const SWARM_ROLE_PROFILES: Record<string, SwarmRoleProfile> = {
	planner: {
		profileId: "swarm-planner",
		identity: { name: "Planner", archetype: "planner" },
		expertise: { domains: ["planning", "architecture"], specialties: ["system-design", "task-decomposition"] },
	},
	implementer: {
		profileId: "swarm-implementer",
		identity: { name: "Implementer", archetype: "implementer" },
		expertise: { domains: ["implementation"], specialties: ["coding", "debugging"] },
	},
	reviewer: {
		profileId: "swarm-reviewer",
		identity: { name: "Reviewer", archetype: "reviewer" },
		expertise: { domains: ["review", "quality"], specialties: ["code-review", "testing"] },
	},
	reflector: {
		profileId: "swarm-reflector",
		identity: { name: "Reflector", archetype: "reflector" },
		expertise: { domains: ["analysis", "learning"], specialties: ["retrospective", "lesson-extraction"] },
	},
};

/** Resolve an AgentSpec to a swarm role profile (predefined or temporary). */
export function resolveSwarmProfile(spec: { id: string; role?: string }): SwarmRoleProfile {
	const role = spec.role?.toLowerCase() ?? "implementer";
	const predefined = SWARM_ROLE_PROFILES[role];
	if (predefined) return { ...predefined, profileId: spec.id };
	return {
		profileId: spec.id,
		identity: { name: spec.role ?? spec.id, archetype: role },
		expertise: { domains: [role], specialties: [] },
	};
}
