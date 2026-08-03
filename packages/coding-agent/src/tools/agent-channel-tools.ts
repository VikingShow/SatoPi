/**
 * agent-channel-tools.ts — Swarm agent communication tools for LLM invocation.
 *
 * Provides 5 tools agents use for group communication:
 *   agent_broadcast      — broadcast to all agents
 *   agent_query_all      — ask all agents and collect all answers
 *   agent_query_majority — ask all agents and return the majority answer
 *   agent_roundtable     — structured multi-round roundtable discussion
 *   agent_peers          — list all online peers
 *
 * These tools depend on IrcBus.global() + CommChannel instances.
 * Callers provide the channel instance via tool context.
 */

import type { AgentTool, AgentToolContext, AgentToolResult } from "@satopi/pi-agent-core";
import type { ToolExample } from "@satopi/pi-ai";
import { logger } from "@satopi/pi-utils";
import { type } from "arktype";
import type { CommChannel } from "../comm/comm-channel";
import type { ActivityLogger } from "../infra/activity-logger";
import { IrcBus } from "../irc/bus";

// ============================================================================
// Types
// ============================================================================

export interface AgentMessage {
	from: string;
	body: string;
	timestamp: number;
}

// ============================================================================
// Shared schema fragments
// ============================================================================

const bodyField = type("string").describe("message body to broadcast");

const questionField = type("string").describe("question to ask all agents");
const timeoutField = type("number").describe("timeout in milliseconds (default 30s)");

const topicField = type("string").describe("topic for roundtable discussion");
const roundsField = type("number").describe("number of discussion rounds (default 2)");

// ============================================================================
// Context extension: expose CommChannel via tool context
// ============================================================================

declare module "@satopi/pi-agent-core" {
	interface AgentToolContext {
		commChannel?: CommChannel;
		activityLogger?: ActivityLogger;
	}
}

/** Resolve CommChannel from tool context or create a fallback from the global bus. */
function resolveChannel(context?: AgentToolContext): CommChannel | undefined {
	if (context?.commChannel) return context.commChannel;

	// Fallback: use the default channel from the global IrcBus
	return IrcBus.global()?.getDefaultChannel();
}

// ============================================================================
// 1. agent_broadcast
// ============================================================================

const broadcastSchema = type({
	body: bodyField,
});

type BroadcastParams = typeof broadcastSchema.infer;

export class AgentBroadcastTool implements AgentTool<typeof broadcastSchema, AgentMessage[]> {
	readonly name = "agent_broadcast";
	readonly approval = "write" as const;
	readonly label = "Agent Broadcast";
	readonly parameters = broadcastSchema;
	readonly summary = "Broadcast a message to all agents in the swarm";
	readonly description = [
		"Broadcast a message to ALL agents in the current swarm.",
		"",
		"Use this to share important findings, request help, or announce completion.",
		"All agents (including yourself) will see this message at the next step boundary.",
		"",
		"Parameters:",
		"- `body`: The message text to broadcast.",
	].join("\n");
	readonly examples: ToolExample[] = [
		{
			caption: "Announce completion of a task phase",
			call: { body: "Phase backend-complete. All API endpoints implemented and tested." },
		},
	];

	readonly concurrency = "exclusive" as const;

	readonly loadMode = "essential" as const;
	readonly lenientArgValidation = false;

	async execute(
		_toolCallId: string,
		params: BroadcastParams,
		_signal?: AbortSignal,
		_onUpdate?: (partial: AgentToolResult<AgentMessage[]>) => void,
		context?: AgentToolContext,
	): Promise<AgentToolResult<AgentMessage[]>> {
		const channel = resolveChannel(context);
		if (!channel) {
			return {
				content: [{ type: "text", text: "ERROR: CommChannel not available. No swarm peers to broadcast to." }],
				isError: true,
			};
		}

		try {
			const from = context?.commChannel ? "agent" : "system";
			await channel.send(from, params.body);

			logger.debug("[AgentBroadcastTool] Broadcast sent", { bodyLen: params.body.length });
			return {
				content: [{ type: "text", text: `Broadcast sent to ${channel.members.size} agents.` }],
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { content: [{ type: "text", text: `Broadcast failed: ${msg}` }], isError: true };
		}
	}
}

// ============================================================================
// 2. agent_query_all
// ============================================================================

const queryAllSchema = type({
	question: questionField,
	"timeout?": timeoutField,
});

type QueryAllParams = typeof queryAllSchema.infer;

export class AgentQueryAllTool implements AgentTool<typeof queryAllSchema, Record<string, string>> {
	readonly name = "agent_query_all";
	readonly approval = "read" as const;
	readonly label = "Query All Agents";
	readonly summary = "Ask all agents a question and collect all answers";
	readonly parameters = queryAllSchema;
	readonly description = [
		"Ask ALL agents in the swarm a question and wait for ALL of their answers.",
		"",
		"Use this to gather opinions, verify facts, or solicit ideas from the group.",
		"Returns a map of agentId → answer for every agent that responded.",
		"",
		"Parameters:",
		"- `question`: The question to ask.",
		"- `timeout` (optional): Max wait time in ms (default 30 seconds).",
	].join("\n");
	readonly examples: ToolExample[] = [
		{
			caption: "Ask all agents which file is most critical",
			call: { question: "Which file in the workspace do you think needs the most refactoring and why?" },
		},
	];

	readonly concurrency = "shared" as const;
	readonly loadMode = "essential" as const;
	readonly lenientArgValidation = false;

	async execute(
		_toolCallId: string,
		params: QueryAllParams,
		_signal?: AbortSignal,
		_onUpdate?: (partial: AgentToolResult<Record<string, string>>) => void,
		context?: AgentToolContext,
	): Promise<AgentToolResult<Record<string, string>>> {
		const channel = resolveChannel(context);
		if (!channel) {
			return {
				content: [{ type: "text", text: "ERROR: CommChannel not available." }],
				isError: true,
			};
		}

		const timeout = params.timeout ?? 30_000;
		const bus = IrcBus.global();

		try {
			// Use IrcBus.collectResponses — broadcast the question then collect answers
			const agentList = [...channel.members];
			if (agentList.length === 0) {
				return { content: [{ type: "text", text: "No agents available." }], isError: true };
			}
			const facilitatorId = agentList[0];
			const responses = await bus.collectResponses(
				facilitatorId,
				agentList,
				{ from: facilitatorId, body: params.question },
				{},
				timeout,
			);

			// Format results
			const resultMap: Record<string, string> = {};
			for (const [agentId, msg] of responses) {
				resultMap[agentId] = msg.body;
			}

			const missed = agentList.length - Object.keys(resultMap).length;
			let text = `Collected ${Object.keys(resultMap).length}/${agentList.length} answers.`;
			if (missed > 0) text += ` ${missed} agent(s) did not respond.`;

			return {
				content: [{ type: "text", text }],
				details: resultMap,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { content: [{ type: "text", text: `Query failed: ${msg}` }], isError: true };
		}
	}
}

// ============================================================================
// 3. agent_query_majority
// ============================================================================

const queryMajoritySchema = type({
	question: questionField,
	"timeout?": timeoutField,
});

type QueryMajorityParams = typeof queryMajoritySchema.infer;

export class AgentQueryMajorityTool implements AgentTool<typeof queryMajoritySchema, string> {
	readonly name = "agent_query_majority";
	readonly approval = "read" as const;
	readonly label = "Query Majority";
	readonly summary = "Ask all agents a question and return the majority answer";
	readonly parameters = queryMajoritySchema;
	readonly description = [
		"Ask ALL agents a question and return the MOST COMMON answer (majority vote).",
		"",
		"Use this for quick consensus checks or binary decisions.",
		"Ties are broken by agent count — the first answer reaching quorum wins.",
		"",
		"Parameters:",
		"- `question`: The question to ask.",
		"- `timeout` (optional): Max wait time in ms (default 30 seconds).",
	].join("\n");
	readonly examples: ToolExample[] = [
		{
			caption: "Vote on approach",
			call: {
				question:
					"Should we use Approach A (incremental) or Approach B (complete rewrite)? Answer with 'A' or 'B'.",
			},
		},
	];

	readonly concurrency = "shared" as const;
	readonly loadMode = "essential" as const;
	readonly lenientArgValidation = false;

	async execute(
		_toolCallId: string,
		params: QueryMajorityParams,
		_signal?: AbortSignal,
		_onUpdate?: (partial: AgentToolResult<string>) => void,
		context?: AgentToolContext,
	): Promise<AgentToolResult<string>> {
		const channel = resolveChannel(context);
		if (!channel) {
			return {
				content: [{ type: "text", text: "ERROR: CommChannel not available." }],
				isError: true,
			};
		}

		const timeout = params.timeout ?? 30_000;
		const bus = IrcBus.global();

		try {
			const agentList = [...channel.members];
			if (agentList.length === 0) {
				return { content: [{ type: "text", text: "No agents available." }], isError: true };
			}
			const facilitatorId = agentList[0];
			const responses = await bus.collectResponses(
				facilitatorId,
				agentList,
				{ from: facilitatorId, body: params.question },
				{},
				timeout,
			);

			if (responses.size === 0) {
				return { content: [{ type: "text", text: "No agents responded." }], isError: true };
			}

			// Tally votes (simple string match on trimmed body)
			const tally = new Map<string, number>();
			for (const [, msg] of responses) {
				const vote = msg.body.trim().toLowerCase();
				tally.set(vote, (tally.get(vote) ?? 0) + 1);
			}

			// Find majority
			let majority = "";
			let maxCount = 0;
			for (const [vote, count] of tally) {
				if (count > maxCount) {
					majority = vote;
					maxCount = count;
				}
			}

			return {
				content: [{ type: "text", text: `Majority: "${majority}" (${maxCount}/${responses.size} votes)` }],
				details: majority,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { content: [{ type: "text", text: `Majority query failed: ${msg}` }], isError: true };
		}
	}
}

// ============================================================================
// 4. agent_roundtable
// ============================================================================

const roundtableSchema = type({
	topic: topicField,
	"rounds?": roundsField,
});

type RoundtableParams = typeof roundtableSchema.infer;

export class AgentRoundtableTool implements AgentTool<typeof roundtableSchema, string[]> {
	readonly name = "agent_roundtable";
	readonly approval = "write" as const;
	readonly label = "Roundtable Discussion";
	readonly summary = "Conduct a structured multi-round discussion among agents";
	readonly parameters = roundtableSchema;
	readonly description = [
		"Initiate a structured multi-round roundtable discussion among swarm agents.",
		"",
		"Each round: every agent states their position, then all can react.",
		"Use this for complex decisions, role negotiation, or divergent thinking.",
		"Returns the final consensus positions from all participants.",
		"",
		"Parameters:",
		"- `topic`: The discussion topic or question.",
		"- `rounds` (optional): Number of discussion rounds (default 2, max 5).",
	].join("\n");
	readonly examples: ToolExample[] = [
		{
			caption: "Role negotiation roundtable",
			call: {
				topic: "Let's assign roles for this project. Each agent, state which role you believe you are best suited for and why.",
			},
		},
	];

	readonly concurrency = "exclusive" as const;
	readonly loadMode = "essential" as const;
	readonly lenientArgValidation = false;

	async execute(
		_toolCallId: string,
		params: RoundtableParams,
		signal?: AbortSignal,
		_onUpdate?: (partial: AgentToolResult<string[]>) => void,
		context?: AgentToolContext,
	): Promise<AgentToolResult<string[]>> {
		const channel = resolveChannel(context);
		if (!channel) {
			return {
				content: [{ type: "text", text: "ERROR: CommChannel not available." }],
				isError: true,
			};
		}

		const rounds = Math.min(params.rounds ?? 2, 5);
		const bus = IrcBus.global();
		const agentList = [...channel.members];

		if (agentList.length === 0) {
			return { content: [{ type: "text", text: "No agents available." }], isError: true };
		}

		const facilitatorId = agentList[0];

		try {
			const positions: string[] = [];

			for (let r = 0; r < rounds; r++) {
				// Each round: broadcast the topic/continuation, collect responses
				const prompt =
					r === 0
						? `[ROUNDTABLE R1/${rounds}] Topic: ${params.topic}\nState your position.`
						: `[ROUNDTABLE R${r + 1}/${rounds}] Respond to the previous round's discussion. Topic: ${params.topic}`;

				await channel.send(facilitatorId, prompt);

				const responses = await bus.collectResponses(facilitatorId, agentList, {
					from: facilitatorId,
					body: prompt,
				});

				for (const [, msg] of responses) {
					positions.push(msg.body);
				}

				signal?.throwIfAborted();
			}

			return {
				content: [
					{
						type: "text",
						text: `Roundtable complete. ${rounds} rounds, ${agentList.length} agents, ${positions.length} positions collected.`,
					},
				],
				details: positions,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { content: [{ type: "text", text: `Roundtable failed: ${msg}` }], isError: true };
		}
	}
}

// ============================================================================
// 5. agent_peers
// ============================================================================

const peersSchema = type({});

export class AgentPeersTool implements AgentTool<typeof peersSchema, Array<{ id: string; role?: string }>> {
	readonly name = "agent_peers";
	readonly approval = "read" as const;
	readonly label = "List Peers";
	readonly summary = "List all online peer agents in the swarm";
	readonly parameters = peersSchema;
	readonly description = [
		"List all online peer agents in the current swarm.",
		"",
		"Use this to discover who is available before broadcasting or querying.",
		"Returns an array of { id, role? } for each peer.",
	].join("\n");
	readonly examples: ToolExample[] = [{ caption: "List peers before deciding who to DM", call: {} }];

	readonly concurrency = "shared" as const;
	readonly loadMode = "essential" as const;
	readonly lenientArgValidation = false;

	// @ts-expect-error TS2416: parameter variance between AgentTool<typeof peersSchema> and AgentPeersTool.execute
	async execute(
		_toolCallId: string,
		_params: Record<string, never>,
		_signal?: AbortSignal,
		_onUpdate?: (partial: AgentToolResult<Array<{ id: string; role?: string }>>) => void,
		context?: AgentToolContext,
	): Promise<AgentToolResult<Array<{ id: string; role?: string }>>> {
		const channel = resolveChannel(context);
		if (!channel) {
			return {
				content: [{ type: "text", text: "ERROR: CommChannel not available." }],
				isError: true,
			};
		}

		const peerList = [...channel.members].map(id => ({ id }));
		const text = `${peerList.length} peer(s) online:\n${peerList.map(p => ` - ${p.id}`).join("\n")}`;

		return {
			content: [{ type: "text", text }],
			details: peerList,
		};
	}
}

// ============================================================================
// Factory: create all 5 tools
// ============================================================================

export interface AgentChannelToolsOptions {
	channel: CommChannel;
	activityLogger?: ActivityLogger;
}

/**
 * Create all 5 swarm communication tools bound to a specific CommChannel instance.
 * Register these via Agent.setTools().
 */
export function createAgentChannelTools(opts: AgentChannelToolsOptions): AgentTool<any, any>[] {
	const context = {
		commChannel: opts.channel,
		activityLogger: opts.activityLogger,
	} as unknown as AgentToolContext;

	// Bind context by wrapping execute
	function withContext(tool: AgentTool<any, any>): AgentTool<any, any> {
		const origExecute = tool.execute.bind(tool);
		return {
			...tool,
			execute: (toolCallId, params, signal, onUpdate) => origExecute(toolCallId, params, signal, onUpdate, context),
		};
	}

	return [
		withContext(new AgentBroadcastTool()),
		withContext(new AgentQueryAllTool()),
		withContext(new AgentQueryMajorityTool()),
		withContext(new AgentRoundtableTool()),
		withContext(new AgentPeersTool()),
	];
}
