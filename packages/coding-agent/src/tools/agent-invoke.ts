/**
 * agent-invoke.ts — Agent Invoke tool.
 *
 * LLM-invokable tool that calls a persistent agent by profileId.
 * Supports inline progress streaming via session.subscribe().
 */

import type { AgentTool, AgentToolContext, AgentToolResult } from "@satopi/pi-agent-core";
import { type } from "arktype";
import { ProfileRegistry } from "../agent/agent-profile";
import { AgentRegistry } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { type AgentProgress, type SingleResult, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "../task/types";

const agentInvokeSchema = type({
	profileId: type("string").describe("Profile ID of the persistent agent to invoke"),
	task: type("string").describe("Task description for the agent"),
});

type AgentInvokeParams = typeof agentInvokeSchema.infer;

export interface AgentInvokeDetails {
	progress: AgentProgress[];
	results: SingleResult[];
	profileId: string;
	displayName: string;
	kind: "persistent";
}

export const agentInvokeTool: AgentTool<typeof agentInvokeSchema, AgentInvokeDetails> = {
	name: "agent_invoke",
	approval: "write" as const,
	label: "Invoke Agent",
	summary: "Call a persistent agent by profileId",
	parameters: agentInvokeSchema,
	description: "Call a persistent agent by its profile ID. Spawns a new session or steers an existing idle one.",
	strict: true as const,
	loadMode: "discoverable" as const,
	formatApprovalDetails: (args: unknown): string[] => {
		const p = args as AgentInvokeParams;
		return [`Profile: ${p.profileId}`, `Task: ${p.task}`];
	},
	concurrency: "shared" as const,

	async execute(
		this: AgentTool<typeof agentInvokeSchema, AgentInvokeDetails>,
		_toolCallId: string,
		params: AgentInvokeParams,
		signal?: AbortSignal,
		_onUpdate?: (partial: AgentToolResult<AgentInvokeDetails>) => void,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AgentInvokeDetails>> {
		const registry = AgentRegistry.global();
		const { profileId, task } = params;
		const agentId = `persist-${profileId}`;

		// Find existing persistent idle agent
		const existing = registry
			.list()
			.find(ref => ref.profileId === profileId && ref.kind === "main" && ref.status === "idle");

		let session: AgentSession | undefined;
		let displayName = agentId;

		if (existing?.session) {
			session = existing.session;
			displayName = existing.displayName;
		} else {
			signal?.throwIfAborted();
			try {
				const result = await createAgentSession({
					agentKind: "main",
					persistentProfileId: profileId,
					agentId,
					agentDisplayName: agentId,
					autoApprove: true,
					hasUI: false,
					hasIrcInterrupts: true,
				});
				session = result.session;
				registry.register({
					id: agentId,
					displayName: agentId,
					kind: "main",
					profileId,
					session,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `agent_invoke failed: ${msg}` }],
					isError: true,
					details: { progress: [], results: [], profileId, displayName: agentId, kind: "persistent" },
				};
			}
		}

		// Emit lifecycle event so the TUI panel picks up this persistent agent
		const eventBus = _context?.eventBus;
		eventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: agentId,
			agent: profileId,
			agentSource: "project" as const,
			description: profileId,
			status: "started" as const,
			index: 0,
			detached: true,
		});

		// Subscribe for live progress streaming
		const progress: AgentProgress[] = [];
		const unsub = session.subscribe(event => {
			if (event.type === "tool_execution_update") {
				const snap: AgentProgress = {
					index: 0,
					id: agentId,
					agent: profileId,
					agentSource: "project",
					status: "running",
					task,
					toolCount: progress.length > 0 ? (progress[progress.length - 1].toolCount ?? 0) + 1 : 1,
					tokens: 0,
					cost: 0,
					durationMs: 0,
					recentTools: [],
					recentOutput: [],
					requests: 0,
				};
				progress.push(snap);
				_onUpdate?.({
					content: [{ type: "text", text: "..." }],
					details: { progress: [...progress], results: [], profileId, displayName, kind: "persistent" },
				});
			}
		});

		try {
			signal?.throwIfAborted();
			await session.prompt(task);
			const result = await session.wait();

			ProfileRegistry.global().recordTaskCompleted(profileId, result.exitCode === 0);
			eventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id: agentId,
				agent: profileId,
				agentSource: "project" as const,
				status: result.exitCode === 0 ? ("completed" as const) : ("failed" as const),
				index: 0,
				detached: true,
			});

			const final: SingleResult = {
				index: 0,
				id: agentId,
				agent: profileId,
				agentSource: "project",
				task,
				exitCode: result.exitCode ?? -1,
				output: result.output || result.stderr || "(no output)",
				stderr: "",
				truncated: false,
				durationMs: 0,
				tokens: 0,
				requests: 0,
			};

			unsub();
			return {
				content: [{ type: "text", text: result.output || result.stderr || "(no output)" }],
				isError: result.exitCode !== 0,
				details: {
					progress: [...progress],
					results: [final],
					profileId,
					displayName,
					kind: "persistent",
				},
			};
		} catch (err) {
			unsub();
			const msg = err instanceof Error ? err.message : String(err);
			try {
				ProfileRegistry.global().recordTaskCompleted(profileId, false);
			} catch {
				/* best-effort */
			}
			eventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id: agentId,
				agent: profileId,
				agentSource: "project" as const,
				status: "failed" as const,
				index: 0,
				detached: true,
			});
			return {
				content: [{ type: "text", text: `agent_invoke failed: ${msg}` }],
				isError: true,
				details: { progress: [...progress], results: [], profileId, displayName, kind: "persistent" },
			};
		}
	},
};
