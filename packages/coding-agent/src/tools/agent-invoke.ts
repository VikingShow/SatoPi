/**
 * agent-invoke.ts — Agent Invoke tool
 *
 * LLM-invokable tool that calls a persistent agent by profileId.
 * If the agent is already running and idle, it steers a new task.
 * Otherwise, it spawns a fresh persistent agent via createAgentSession.
 */

import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { ProfileRegistry } from "../agent/agent-profile";
import { AgentRegistry } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";

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

	/** Dynamically hidden when no agent profiles are registered. */
	get hidden(): boolean {
		return ProfileRegistry.global().list().length === 0;
	},

	async execute(
		_toolCallId: string,
		params: AgentInvokeParams,
		signal?: AbortSignal,
		_onUpdate?: (partial: AgentToolResult<string>) => void,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<string>> {
		const registry = AgentRegistry.global();
		const { profileId, task } = params;

		// Find existing persistent idle agent by profileId
		const existing = registry
			.list()
			.find(ref => ref.profileId === profileId && ref.kind === "persistent" && ref.status === "idle");

		let session: AgentSession | undefined;
		if (existing?.session) {
			// Steer the existing session with the new task
			logger.info("[agent_invoke] Steering existing persistent agent", {
				id: existing.id,
				profileId,
			});
			session = existing.session;
		} else {
			// Spawn new persistent agent session
			logger.info("[agent_invoke] Creating new persistent agent session", { profileId });
			signal?.throwIfAborted();

			try {
				const result = await createAgentSession({
					agentKind: "persistent",
					persistentProfileId: profileId,
					agentId: `persist-${profileId}`,
					autoApprove: true,
					hasUI: false,
					hasIrcInterrupts: true,
				});
				session = result.session;
				// Register in the agent registry
				registry.register({
					id: `persist-${profileId}`,
					displayName: `persist-${profileId}`,
					kind: "persistent",
					profileId,
					session,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				logger.error("[agent_invoke] Session creation failed", { profileId, error: msg });
				return {
					content: [{ type: "text", text: `agent_invoke failed: ${msg}` }],
					isError: true,
				};
			}
		}

		// Start the task and wait for completion
		try {
			signal?.throwIfAborted();
			await session.prompt(task);
			const result = await session.wait();

			// Track profile credit
			const profileRegistry = ProfileRegistry.global();
			profileRegistry.recordTaskCompleted(profileId, result.exitCode === 0);

			return {
				content: [
					{
						type: "text",
						text: result.output || result.stderr || "(no output)",
					},
				],
				isError: result.exitCode !== 0,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			logger.error("[agent_invoke] Task execution failed", { profileId, error: msg });
			// Still record the failure in profile
			try {
				ProfileRegistry.global().recordTaskCompleted(profileId, false);
			} catch {
				// best-effort
			}
			return {
				content: [{ type: "text", text: `agent_invoke failed: ${msg}` }],
				isError: true,
			};
		}
	},
};
