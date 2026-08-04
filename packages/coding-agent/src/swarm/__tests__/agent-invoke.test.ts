/**
 * agent-invoke.test.ts — E2E tests for agent_invoke tool integration.
 *
 * Verifies:
 * - agent_invoke creates new persistent sessions via createAgentSession
 * - agent_invoke steers existing idle persistent agents
 * - Error handling on session creation / task failures
 * - Hidden behavior when no profiles are registered
 * - Profile credit tracking via ProfileRegistry
 */

import { afterEach, beforeEach, describe, expect, it, type Mock, mock, vi } from "bun:test";
import type { AgentToolContext } from "@satopi/pi-agent-core";
import { ProfileRegistry } from "../../agent/agent-profile";
import { AgentRegistry } from "../../registry/agent-registry";
import type { CreateAgentSessionResult } from "../../sdk";
import * as sdkModule from "../../sdk";
import type { AgentSession } from "../../session/agent/agent-session";
import { agentInvokeTool } from "../../tools/agent-invoke";

let mockCreateAgentSession: Mock<typeof sdkModule.createAgentSession>;

// ============================================================================
// Helpers
// ============================================================================

/** Create a minimal mock AgentSession for testing. */
function makeMockSession(overrides?: Record<string, unknown>): AgentSession {
	return {
		prompt: mock().mockResolvedValue(true),
		wait: mock().mockResolvedValue({ output: "Task completed", exitCode: 0 }),
		subscribe: mock().mockReturnValue(() => {}),
		...overrides,
	} as unknown as AgentSession;
}

/** Minimal createAgentSession result carrying the session under test. */
function makeSessionResult(session: AgentSession): CreateAgentSessionResult {
	return { session } as unknown as CreateAgentSessionResult;
}

// ============================================================================
// Cleanup
// ============================================================================

beforeEach(() => {
	// Clear AgentRegistry global state to prevent cross-test leakage.
	const registry = AgentRegistry.global();
	for (const ref of registry.list()) {
		registry.unregister(ref.id);
	}
	// Reset ProfileRegistry for clean slate
	ProfileRegistry.resetGlobalForTests();
	mockCreateAgentSession = vi.spyOn(sdkModule, "createAgentSession");
});

afterEach(() => {
	vi.restoreAllMocks();
});
// ============================================================================
// Tests
// ============================================================================
describe("agent_invoke E2E", () => {
	describe("agent_invoke creates new persistent session", () => {
		it("calls createAgentSession with correct options and waits for completion", async () => {
			// Register a profile so the tool is visible
			ProfileRegistry.global().createProfile({
				profileId: "testProfile",
				name: "Test Agent",
				archetype: "worker",
			});

			const mockSession = makeMockSession();
			mockCreateAgentSession.mockResolvedValue(makeSessionResult(mockSession));

			const result = await agentInvokeTool.execute(
				"toolCall-1",
				{ profileId: "testProfile", task: "Build the API endpoint" },
				undefined, // signal
				undefined, // onUpdate
				{} as AgentToolContext,
			);

			// Verify createAgentSession was called with the correct options
			expect(mockCreateAgentSession).toHaveBeenCalledTimes(1);
			expect(mockCreateAgentSession).toHaveBeenCalledWith({
				agentKind: "main",
				profileId: "testProfile",
				agentId: "persist-testProfile",
				agentDisplayName: "persist-testProfile",
				autoApprove: true,
				hasUI: false,
				hasIrcInterrupts: true,
			});

			// Verify session.prompt and session.wait were called
			expect(mockSession.prompt).toHaveBeenCalledWith("Build the API endpoint");
			expect(mockSession.wait).toHaveBeenCalled();

			// Verify result
			expect(result.isError).toBe(false);
			expect(result.content).toEqual([{ type: "text", text: "Task completed" }]);

			// Verify profile credit was tracked
			const profile = ProfileRegistry.global().get("testProfile");
			expect(profile?.credit.totalTasks).toBe(1);
			expect(profile?.credit.successRate).toBe(1);
		});

		it("returns error when createAgentSession throws", async () => {
			ProfileRegistry.global().createProfile({
				profileId: "crashing",
				name: "Crash Agent",
				archetype: "worker",
			});

			mockCreateAgentSession.mockRejectedValue(new Error("No model available"));

			const result = await agentInvokeTool.execute(
				"toolCall-1",
				{ profileId: "crashing", task: "Test task" },
				undefined,
				undefined,
				{} as AgentToolContext,
			);

			expect(result.isError).toBe(true);
			expect(result.content?.[0]).toEqual({
				type: "text",
				text: "agent_invoke failed: No model available",
			});
		});

		it("returns error when task execution fails", async () => {
			ProfileRegistry.global().createProfile({
				profileId: "failingTask",
				name: "Failing Agent",
				archetype: "worker",
			});

			const mockSession = makeMockSession({
				prompt: mock().mockRejectedValue(new Error("Task rejected")),
			});
			mockCreateAgentSession.mockResolvedValue(makeSessionResult(mockSession));

			const result = await agentInvokeTool.execute(
				"toolCall-1",
				{ profileId: "failingTask", task: "Test task" },
				undefined,
				undefined,
				{} as AgentToolContext,
			);

			expect(result.isError).toBe(true);
			expect(result.content?.[0]).toEqual({
				type: "text",
				text: "agent_invoke failed: Task rejected",
			});
		});

		it("records failed completion in profile even when task throws", async () => {
			ProfileRegistry.global().createProfile({
				profileId: "throwCredit",
				name: "Throw Credit",
				archetype: "worker",
			});

			const mockSession = makeMockSession({
				prompt: mock().mockRejectedValue(new Error("Boom")),
			});
			mockCreateAgentSession.mockResolvedValue(makeSessionResult(mockSession));

			await agentInvokeTool.execute(
				"toolCall-1",
				{ profileId: "throwCredit", task: "Boom task" },
				undefined,
				undefined,
				{} as AgentToolContext,
			);

			const profile = ProfileRegistry.global().get("throwCredit");
			expect(profile?.credit.totalTasks).toBe(1);
			expect(profile?.credit.successRate).toBe(0);
		});
	});

	describe("agent_invoke steers existing idle persistent agent", () => {
		it("reuses existing idle session instead of creating new one", async () => {
			ProfileRegistry.global().createProfile({
				profileId: "existingProfile",
				name: "Existing Agent",
				archetype: "worker",
			});

			const mockSession = makeMockSession();
			// Register an existing idle persistent agent
			AgentRegistry.global().register({
				id: "persist-existingProfile",
				displayName: "persist-existingProfile",
				kind: "main",
				profileId: "existingProfile",
				session: mockSession as unknown as AgentSession,
				status: "idle",
			});

			mockCreateAgentSession.mockClear();

			const result = await agentInvokeTool.execute(
				"toolCall-1",
				{ profileId: "existingProfile", task: "New steering task" },
				undefined,
				undefined,
				{} as AgentToolContext,
			);

			// Should NOT create a new session
			expect(mockCreateAgentSession).not.toHaveBeenCalled();

			// Should steer the existing session
			expect(mockSession.prompt).toHaveBeenCalledWith("New steering task");
			expect(mockSession.wait).toHaveBeenCalled();

			expect(result.isError).toBe(false);
			expect(result.content).toEqual([{ type: "text", text: "Task completed" }]);
		});

		it("creates new session when existing agent is not idle", async () => {
			ProfileRegistry.global().createProfile({
				profileId: "busyProfile",
				name: "Busy Agent",
				archetype: "worker",
			});

			// Register a persistent agent that is running (not idle)
			AgentRegistry.global().register({
				id: "persist-busyProfile",
				displayName: "persist-busyProfile",
				kind: "main",
				profileId: "busyProfile",
				session: null,
				status: "running",
			});

			const mockSession = makeMockSession();
			mockCreateAgentSession.mockResolvedValue(makeSessionResult(mockSession));

			const result = await agentInvokeTool.execute(
				"toolCall-1",
				{ profileId: "busyProfile", task: "Task while busy" },
				undefined,
				undefined,
				{} as AgentToolContext,
			);

			// Should create a new session since the existing one is not idle
			expect(mockCreateAgentSession).toHaveBeenCalled();
			expect(result.isError).toBe(false);
		});
	});

	describe("profile credit tracking", () => {
		it("records successful task completion", async () => {
			ProfileRegistry.global().createProfile({
				profileId: "creditProfile",
				name: "Credit Agent",
				archetype: "worker",
			});

			const mockSession = makeMockSession({
				wait: mock().mockResolvedValue({ output: "Done", exitCode: 0 }),
			});
			mockCreateAgentSession.mockResolvedValue(makeSessionResult(mockSession));

			await agentInvokeTool.execute(
				"toolCall-1",
				{ profileId: "creditProfile", task: "A successful task" },
				undefined,
				undefined,
				{} as AgentToolContext,
			);

			const profile = ProfileRegistry.global().get("creditProfile");
			expect(profile?.credit.totalTasks).toBe(1);
			expect(profile?.credit.score).toBeGreaterThan(50); // rewarded for success
		});

		it("records failed task completion", async () => {
			ProfileRegistry.global().createProfile({
				profileId: "failCredit",
				name: "Fail Credit",
				archetype: "worker",
			});

			const mockSession = makeMockSession({
				wait: mock().mockResolvedValue({ output: "Error occurred", exitCode: 1 }),
			});
			mockCreateAgentSession.mockResolvedValue(makeSessionResult(mockSession));

			await agentInvokeTool.execute(
				"toolCall-1",
				{ profileId: "failCredit", task: "A failing task" },
				undefined,
				undefined,
				{} as AgentToolContext,
			);

			const profile = ProfileRegistry.global().get("failCredit");
			expect(profile?.credit.totalTasks).toBe(1);
			expect(profile?.credit.successRate).toBe(0); // failed
		});
	});
});
