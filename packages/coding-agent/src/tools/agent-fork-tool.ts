/**
 * agent-fork-tool.ts — Agent Fork tool
 *
 * LLM 可调用的 Fork 工具。Agent 感知任务过多时调用此工具:
 *   agent_fork({ reason: "Task too complex", count: 3 })
 */

import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AgentForkManager, type ForkResult } from "../../swarm/agent/agent-fork-manager";

// ============================================================================
// Context extension
// ============================================================================

declare module "@oh-my-pi/pi-agent-core" {
	interface AgentToolContext {
		/** Parent agent instance (for fork context) */
		parentAgent?: Agent;
		/** Create a new Agent instance from forkable state */
		createChildAgent?: (childId: string, initialState: { systemPrompt: string[]; model: any; tools: any[]; messages: any[] }) => Agent;
	}
}

// ============================================================================
// Schema
// ============================================================================

const forkSchema = type({
	reason: type("string").describe("Why is forking needed? (e.g. 'task is too complex for one agent')"),
	"count?": type("number").describe("Number of child agents to fork (default 2, max 4)"),
	"task?": type("string").describe("Description of the main task to decompose into subtasks"),
});

type ForkParams = typeof forkSchema.infer;

// ============================================================================
// AgentForkTool
// ============================================================================

export class AgentForkTool implements AgentTool<typeof forkSchema, ForkResult> {
	readonly name = "agent_fork";
	readonly approval = "write" as const;
	readonly label = "Fork Agent";
	readonly summary = "Fork yourself into multiple child agents to handle complex tasks in parallel";
	readonly description = [
		"FORK yourself into multiple child agents to handle a complex task in parallel.",
		"",
		"Use when:",
		"- The task is too large or complex for one agent",
		"- Multiple independent sub-problems can be solved simultaneously",
		"- You need specialized perspectives on the same problem",
		"",
		"Each child agent inherits your context (system prompt, tools, message history)",
		"and works on an assigned subtask. Results are merged when all children complete.",
		"",
		"⚠️ Fork depth is limited to 1 level — child agents cannot fork further.",
		"",
		"Parameters:",
		"- `reason`: Why you need to fork.",
		"- `count` (optional): Number of children (default 2, max 4).",
		"- `task` (optional): Task description. If omitted, inferred from context.",
	].join("\n");
	readonly examples: ToolExample[] = [
		{
			description: "Fork to handle complex multi-module task",
			params: {
				reason: "Need parallel work on backend API, frontend UI, and database schema",
				count: 3,
				task: "Implement full-stack feature: REST API + React UI + DB migration",
			},
			result: "3 child agents created, working in parallel",
		},
	];

	readonly concurrency = "exclusive" as const;
	readonly loadMode = "discoverable" as const;
	readonly lenientArgValidation = false;

	async execute(
		toolCallId: string,
		params: ForkParams,
		signal?: AbortSignal,
		onUpdate?: (partial: AgentToolResult<ForkResult>) => void,
		context?: AgentToolContext,
	): Promise<AgentToolResult<ForkResult>> {
		const parentAgent = context?.parentAgent;
		if (!parentAgent) {
			return {
				content: [{ type: "text", text: "ERROR: No parent agent available. Fork requires a parent agent context." }],
				isError: true,
			};
		}

		const count = Math.min(params.count ?? 2, 4);
		const task = params.task ?? "Complete the user's request using parallel agents";

		try {
			const forkManager = new AgentForkManager(1);

			const forkResult = await forkManager.fork(parentAgent, task, {
				count,
				reason: params.reason,
			});

			signal?.throwIfAborted();

			// Wait for and collect results
			const finalResult = await forkManager.collectResults(parentAgent);

			onUpdate?.({
				content: [{ type: "text", text: `Forked into ${count} child agents. All completed.` }],
				details: finalResult,
			});

			logger.info("[AgentForkTool] Fork complete", {
				count, childIds: finalResult.childIds,
				mergedLen: finalResult.mergedOutput.length,
			});

			return {
				content: [{ type: "text", text: finalResult.mergedOutput.slice(0, 5000) }],
				details: finalResult,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { content: [{ type: "text", text: `Fork failed: ${msg}` }], isError: true };
		}
	}
}
