/**
 * agent-channel-tools.ts — AgentChannel 封装为 LLM 可调用的 AgentTool
 *
 * 提供 5 个工具让 Agent 进行群组通信:
 *   agent_broadcast      — 向所有 agent 广播消息
 *   agent_query_all      — 询问所有 agent 并收集全部回答
 *   agent_query_majority — 询问所有 agent 并取多数回答
 *   agent_roundtable     — 组织结构化多轮圆桌讨论
 *   agent_peers          — 列出所有在线 peer
 *
 * 这些工具依赖 IrcBus.global() + AgentChannel 实例。
 * 调用方需要在 Agent 创建时提供 channel 实例（通过 tool context）。
 */

import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { IrcBus } from "../irc/bus";
import { AgentChannel, type AgentMessage } from "../swarm/channel/agent-channel";
import type { ActivityLogger } from "../swarm/hooks/activity-logger";

// ============================================================================
// Shared schema fragments
// ============================================================================

const bodyField = type("string").describe("message body to broadcast");

const questionField = type("string").describe("question to ask all agents");
const timeoutField = type("number").describe("timeout in milliseconds (default 30s)");

const topicField = type("string").describe("topic for roundtable discussion");
const roundsField = type("number").describe("number of discussion rounds (default 2)");

// ============================================================================
// Context extension: expose AgentChannel via tool context
// ============================================================================

declare module "@oh-my-pi/pi-agent-core" {
	interface AgentToolContext {
		agentChannel?: AgentChannel;
		activityLogger?: ActivityLogger;
	}
}

/** Resolve AgentChannel from tool context or create a fallback from the global bus. */
function resolveChannel(context?: AgentToolContext): AgentChannel | undefined {
	if (context?.agentChannel) return context.agentChannel;

	// Fallback: create a minimal channel from global IrcBus
	const bus = IrcBus.global();
	if (!bus) return undefined;

	// Use an empty channel — the tool will populate as needed
	return new AgentChannel(bus, { agents: [], observers: [] }, context?.activityLogger);
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
		{ description: "Announce completion of a task phase", params: { body: "Phase backend-complete. All API endpoints implemented and tested." }, result: "Broadcast sent to 4 agents" },
	];

	readonly concurrency = "exclusive" as const;

	readonly loadMode = "essential" as const;
	readonly lenientArgValidation = false;

	async execute(
		toolCallId: string,
		params: BroadcastParams,
		signal?: AbortSignal,
		onUpdate?: (partial: AgentToolResult<AgentMessage[]>) => void,
		context?: AgentToolContext,
	): Promise<AgentToolResult<AgentMessage[]>> {
		const channel = resolveChannel(context);
		if (!channel) {
			return {
				content: [{ type: "text", text: "ERROR: AgentChannel not available. No swarm peers to broadcast to." }],
				isError: true,
			};
		}

		try {
			const from = context?.agentChannel ? "agent" : "system";
			await channel.broadcast(from, params.body);

			logger.debug("[AgentBroadcastTool] Broadcast sent", { bodyLen: params.body.length });
			return {
				content: [{ type: "text", text: `Broadcast sent to ${channel.agents.size} agents.` }],
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
		{ description: "Ask all agents which file is most critical", params: { question: "Which file in the workspace do you think needs the most refactoring and why?" }, result: "collected 3/3 answers" },
	];

	readonly concurrency = "shared" as const;
	readonly loadMode = "essential" as const;
	readonly lenientArgValidation = false;

	async execute(
		toolCallId: string,
		params: QueryAllParams,
		signal?: AbortSignal,
		onUpdate?: (partial: AgentToolResult<Record<string, string>>) => void,
		context?: AgentToolContext,
	): Promise<AgentToolResult<Record<string, string>>> {
		const channel = resolveChannel(context);
		if (!channel) {
			return {
				content: [{ type: "text", text: "ERROR: AgentChannel not available." }],
				isError: true,
			};
		}

		const timeout = params.timeout ?? 30_000;
		const bus = IrcBus.global();

		try {
			// Use IrcBus.collectResponses — broadcast the question then collect answers
			const agentList = [...channel.agents];
			const responses = await bus.collectResponses(
				"agent",           // callerId
				agentList,         // all peer agents
				{ from: "agent", body: params.question },
				{},                // accept from anyone
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
		{ description: "Vote on approach", params: { question: "Should we use Approach A (incremental) or Approach B (complete rewrite)? Answer with 'A' or 'B'." }, result: "majority='A' (3/4 votes)" },
	];

	readonly concurrency = "shared" as const;
	readonly loadMode = "essential" as const;
	readonly lenientArgValidation = false;

	async execute(
		toolCallId: string,
		params: QueryMajorityParams,
		signal?: AbortSignal,
		onUpdate?: (partial: AgentToolResult<string>) => void,
		context?: AgentToolContext,
	): Promise<AgentToolResult<string>> {
		const channel = resolveChannel(context);
		if (!channel) {
			return {
				content: [{ type: "text", text: "ERROR: AgentChannel not available." }],
				isError: true,
			};
		}

		const timeout = params.timeout ?? 30_000;
		const bus = IrcBus.global();

		try {
			const agentList = [...channel.agents];
			const responses = await bus.collectResponses(
				"agent", agentList,
				{ from: "agent", body: params.question },
				{}, timeout,
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
				if (count > maxCount) { majority = vote; maxCount = count; }
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
		{ description: "Role negotiation roundtable", params: { topic: "Let's assign roles for this project. Each agent, state which role you believe you are best suited for and why." }, result: "roundtable complete — roles assigned" },
	];

	readonly concurrency = "exclusive" as const;
	readonly loadMode = "essential" as const;
	readonly lenientArgValidation = false;

	async execute(
		toolCallId: string,
		params: RoundtableParams,
		signal?: AbortSignal,
		onUpdate?: (partial: AgentToolResult<string[]>) => void,
		context?: AgentToolContext,
	): Promise<AgentToolResult<string[]>> {
		const channel = resolveChannel(context);
		if (!channel) {
			return {
				content: [{ type: "text", text: "ERROR: AgentChannel not available." }],
				isError: true,
			};
		}

		const rounds = Math.min(params.rounds ?? 2, 5);
		const bus = IrcBus.global();
		const agentList = [...channel.agents];

		try {
			const positions: string[] = [];

			for (let r = 0; r < rounds; r++) {
				// Each round: broadcast the topic/continuation, collect responses
				const prompt = r === 0
					? `[ROUNDTABLE R1/${rounds}] Topic: ${params.topic}\nState your position.`
					: `[ROUNDTABLE R${r + 1}/${rounds}] Respond to the previous round's discussion. Topic: ${params.topic}`;

				await channel.broadcast("agent", prompt);

				const responses = await bus.collectResponses(
					"agent", agentList,
					{ from: "agent", body: prompt },
					{}, 30_000,
				);

				for (const [, msg] of responses) {
					positions.push(msg.body);
				}

				signal?.throwIfAborted();
			}

			return {
				content: [{ type: "text", text: `Roundtable complete. ${rounds} rounds, ${agentList.length} agents, ${positions.length} positions collected.` }],
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
	readonly description = [
		"List all online peer agents in the current swarm.",
		"",
		"Use this to discover who is available before broadcasting or querying.",
		"Returns an array of { id, role? } for each peer.",
	].join("\n");
	readonly examples: ToolExample[] = [
		{ description: "List peers before deciding who to DM", params: {}, result: "3 peers: agent-1 (worker), agent-2 (worker), agent-3 (reviewer)" },
	];

	readonly concurrency = "shared" as const;
	readonly loadMode = "essential" as const;
	readonly lenientArgValidation = false;

	async execute(
		toolCallId: string,
		_params: Record<string, never>,
		signal?: AbortSignal,
		onUpdate?: (partial: AgentToolResult<Array<{ id: string; role?: string }>>) => void,
		context?: AgentToolContext,
	): Promise<AgentToolResult<Array<{ id: string; role?: string }>>> {
		const channel = resolveChannel(context);
		if (!channel) {
			return {
				content: [{ type: "text", text: "ERROR: AgentChannel not available." }],
				isError: true,
			};
		}

		const peerList = [...channel.agents].map(id => ({ id }));
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
	channel: AgentChannel;
	activityLogger?: ActivityLogger;
}

/**
 * Create all 5 AgentChannel tools bound to a specific AgentChannel instance.
 * Register these via Agent.setTools().
 */
export function createAgentChannelTools(opts: AgentChannelToolsOptions): AgentTool<any, any>[] {
	const context: AgentToolContext = {
		agentChannel: opts.channel,
		activityLogger: opts.activityLogger,
	};

	// Bind context by wrapping execute
	function withContext<T>(tool: AgentTool<any, any>): AgentTool<any, any> {
		const origExecute = tool.execute.bind(tool);
		return {
			...tool,
			execute: (toolCallId, params, signal, onUpdate) =>
				origExecute(toolCallId, params, signal, onUpdate, context),
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
