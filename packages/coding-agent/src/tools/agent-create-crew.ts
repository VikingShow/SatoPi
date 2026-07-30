/**
 * agent-create-crew.ts — Agent tool for creating a crew (group chat).
 *
 * Agents call this to spin up a new crew with named members and a topic.
 * The crew wraps a CommChannel for messaging; transcript is persisted to
 * JSONL by CrewManager via the channel's afterSend callback.
 */

import type { AgentTool, AgentToolContext, AgentToolResult } from "@satopi/pi-agent-core";
import type { ToolExample } from "@satopi/pi-ai";
import { logger } from "@satopi/pi-utils";
import { type } from "arktype";
import { CrewManager } from "../crew/crew-manager";
import { IrcBus } from "../irc/bus";

// ============================================================================
// Context extension
// ============================================================================

declare module "@satopi/pi-agent-core" {
	interface AgentToolContext {
		crewManager?: CrewManager;
		swarmDir?: string;
	}
}

// ============================================================================
// Schema
// ============================================================================

const createCrewSchema = type({
	members: type("string[]").describe("Agent IDs to include as members"),
	topic: type("string").describe("Topic or purpose of the crew"),
});

type CreateCrewParams = typeof createCrewSchema.infer;

// ============================================================================
// Singleton CrewManager (lazy)
// ============================================================================

let _globalCrewManager: CrewManager | undefined;

function resolveCrewManager(context?: AgentToolContext): CrewManager {
	if (context?.crewManager) return context.crewManager;

	if (!_globalCrewManager) {
		const swarmDir = context?.swarmDir ?? process.cwd();
		const crewsDir = `${swarmDir}/.stp/sessions/crews`;
		_globalCrewManager = new CrewManager(crewsDir, IrcBus.global());
	}

	return _globalCrewManager;
}

// ============================================================================
// AgentCreateCrewTool
// ============================================================================

export class AgentCreateCrewTool implements AgentTool<typeof createCrewSchema, { crewId: string }> {
	readonly name = "agent_create_crew";
	readonly approval = "write" as const;
	readonly label = "Create Crew";
	readonly parameters = createCrewSchema;
	readonly summary = "Create a new agent crew (group chat)";
	readonly description = [
		"Create a new crew (group chat) with specified agents as members.",
		"",
		"Use this to spin up a collaborative group for discussion or task coordination.",
		"The calling agent and the human are automatically included.",
		"All messages sent through the crew channel are persisted to a transcript.",
		"",
		"Parameters:",
		"- `members`: Agent IDs to include as members.",
		"- `topic`: Topic or purpose of the crew.",
	].join("\n");
	readonly examples: ToolExample[] = [
		{
			caption: "Create a review crew",
			call: { members: ["architect", "reviewer"], topic: "Code review for PR #42" },
		},
	];

	readonly concurrency = "shared" as const;
	readonly loadMode = "essential" as const;
	readonly lenientArgValidation = false;

	async execute(
		_toolCallId: string,
		params: CreateCrewParams,
		_signal?: AbortSignal,
		_onUpdate?: (partial: AgentToolResult<{ crewId: string }>) => void,
		context?: AgentToolContext,
	): Promise<AgentToolResult<{ crewId: string }>> {
		try {
			const crewManager = resolveCrewManager(context);

			// Ensure members are deduplicated and include human
			const uniqueMembers = [...new Set(params.members)];

			const crewId = await crewManager.createCrew(params.topic, uniqueMembers, true);

			// Broadcast a join notification through the crew channel
			const crew = crewManager.getCrew(crewId);
			if (crew) {
				await crew.channel.send(
					"system",
					`[System] Crew "${params.topic}" created. Members: ${uniqueMembers.join(", ")}`,
				);
			}

			logger.info("[AgentCreateCrewTool] Crew created", {
				crewId,
				topic: params.topic,
				memberCount: uniqueMembers.length,
			});

			return {
				content: [
					{
						type: "text",
						text: `Crew "${params.topic}" created with ID ${crewId}. Members: ${uniqueMembers.join(", ")}`,
					},
				],
				details: { crewId },
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text", text: `Failed to create crew: ${msg}` }],
				isError: true,
			};
		}
	}
}
