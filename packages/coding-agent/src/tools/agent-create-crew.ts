/**
 * agent_create_crew — LLM-callable tool for creating agent group chats.
 *
 * When an agent calls this tool, a new Crew is created with the specified
 * members. Human is automatically added as observer.
 */

import type { AgentTool, AgentToolContext, AgentToolResult } from "@satopi/pi-agent-core";
import { logger } from "@satopi/pi-utils";
import type { CrewManager } from "../crew/crew-manager";

/** Lazy accessor so the tool can be registered before CrewManager is created. */
let _crewManagerFactory: (() => CrewManager | undefined) | undefined;

export function setAgentCreateCrewCrewManagerFactory(factory: () => CrewManager | undefined): void {
	_crewManagerFactory = factory;
}

function getCrewManager(): CrewManager | undefined {
	return _crewManagerFactory?.();
}

function validateParams(params: unknown): { members: string[]; topic: string } {
	if (!params || typeof params !== "object") {
		throw new Error("agent_create_crew requires an object with 'members' and 'topic' fields");
	}
	const p = params as Record<string, unknown>;
	if (!Array.isArray(p.members) || p.members.length === 0) {
		throw new Error("agent_create_crew requires at least one member in 'members' array");
	}
	if (typeof p.topic !== "string" || p.topic.trim().length === 0) {
		throw new Error("agent_create_crew requires a non-empty 'topic' string");
	}
	return { members: p.members as string[], topic: p.topic };
}

export const agentCreateCrewTool: AgentTool = {
	name: "agent_create_crew",
	description:
		"Create a group chat with specified agents. Human is auto-added as observer. Use this to coordinate multi-agent discussions.",
	parameters: {
		type: "object",
		properties: {
			members: {
				type: "array",
				items: { type: "string" },
				description: "Agent IDs to include in the crew",
			},
			topic: {
				type: "string",
				description: "Discussion topic (displayed in sidebar)",
			},
		},
		required: ["members", "topic"],
	},
	async execute(params: unknown, _ctx: AgentToolContext): Promise<AgentToolResult> {
		const { members, topic } = validateParams(params);
		const crewManager = getCrewManager();
		if (!crewManager) {
			return { content: "CrewManager is not available — swarm is not active.", isError: true };
		}
		try {
			const crewId = await crewManager.createCrew(topic.trim(), members, true);
			logger.info("[agent_create_crew] Crew created", { crewId, topic, memberCount: members.length });
			return {
				content: `Crew "${topic.trim()}" created with ID \`${crewId}\`. Members: ${members.join(", ")}. Human has been added as observer.`,
			};
		} catch (err) {
			return { content: `Failed to create crew: ${err instanceof Error ? err.message : String(err)}`, isError: true };
		}
	},
};
