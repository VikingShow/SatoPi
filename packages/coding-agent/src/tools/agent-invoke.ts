/**
 * agent-invoke.ts — Agent Invoke tool
 *
 * LLM-invokable tool that calls a persistent agent by profileId.
 * If the agent is already running and idle, it steers a new task.
 * Otherwise, it spawns a fresh persistent agent via AgentRuntime.
 */

import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentRuntime } from "../swarm/agent-runtime";

// ============================================================================
// Context extension: expose AgentRuntime via tool context
// ============================================================================

declare module "@oh-my-pi/pi-agent-core" {
	interface AgentToolContext {
		/** AgentRuntime for spawning and steering persistent agents. */
		agentRuntime?: AgentRuntime;
	}
}

// ============================================================================
// Schema
// ============================================================================

const agentInvokeSchema = type({
	profileId: type("string").describe("Profile ID of the persistent agent to invoke"),
	task: type("string").describe("Task description for the agent"),
});

type AgentInvokeParams = typeof agentInvokeSchema.infer;

// ============================================================================
// agentInvokeTool
// ============================================================================

export const agentInvokeTool: AgentTool<typeof agentInvokeSchema, string> = {
	name: "agent_invoke",
	approval: "write" as const,
	label: "Invoke Agent",
	summary: "Call a persistent agent by profileId — spawns or steers as needed",
	parameters: agentInvokeSchema,
	description: [
		"Call a persistent agent by its profile ID. If the agent is already running",
		"and idle, the task is routed to it directly. Otherwise a new persistent agent",
		"is spawned with the given profile and task.",
		"",
		"Parameters:",
		"- `profileId`: The profile ID of the persistent agent to invoke.",
		"- `task`: The task description for the agent to work on.",
	].join("\n"),
	concurrency: "exclusive" as const,
	loadMode: "discoverable" as const,
	lenientArgValidation: false,

	async execute(
		_toolCallId: string,
		params: AgentInvokeParams,
		signal?: AbortSignal,
		_onUpdate?: (partial: AgentToolResult<string>) => void,
		context?: AgentToolContext,
	): Promise<AgentToolResult<string>> {
		const registry = AgentRegistry.global();
		const runtime = context?.agentRuntime;

		if (!runtime) {
			return {
				content: [{ type: "text", text: "agent_invoke: AgentRuntime not available in tool context." }],
				isError: true,
			};
		}

		const { profileId, task } = params;

		// Find existing persistent agent by profileId
		const existing = registry.list().find(
			ref => ref.profileId === profileId && ref.kind === "persistent",
		);

		if (existing && existing.session && existing.status === "idle") {
			// Identity-level reuse: the existing persistent agent's identity
			// (profileId, credit, dashboard entry) is preserved. We spawn a
			// new agent session with the same profileId, which AgentRegistry
			// merges by disposing the old session. Process-level steer/reuse
			// of the live agent handle is a future optimization (P3).
			logger.info("[agent_invoke] Reusing persistent agent identity", {
				id: existing.id,
				profileId,
			});
		}

		// Spawn new persistent agent
		try {
			signal?.throwIfAborted();

			const handles = await runtime.spawn([
				{
					id: `persist-${profileId}`,
					role: "persistent",
					roleSource: "library",
					task,
					profileId,
				},
			]);

			signal?.throwIfAborted();

			const handle = handles[0];
			if (!handle) {
				return {
					content: [{ type: "text", text: "agent_invoke: Spawn returned no handles." }],
					isError: true,
				};
			}

			const result = await handle.wait();

			return {
				content: [
					{
						type: "text",
						text: result.output || result.error || "(no output)",
					},
				],
				isError: result.exitCode !== 0,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("[agent_invoke] Spawn failed", { profileId, error: msg });
			return {
				content: [{ type: "text", text: `agent_invoke failed: ${msg}` }],
				isError: true,
			};
		}
	},
};
