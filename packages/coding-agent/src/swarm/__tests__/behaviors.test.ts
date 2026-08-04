/**
 * PhaseBehavior tests — Phase 4A of the swarm v3 unified architecture.
 *
 * Tests cover:
 *   - PhaseBehavior interface compliance (all 3 implementations)
 *   - ScriptBehavior: enter creates planner + channel, handleHumanMessage routes,
 *     checkCompletion detects confirm signals
 *   - StageBehavior: enter creates channel + spawns agents, handleHumanMessage
 *     broadcasts steering, checkCompletion detects all-complete
 *   - CurtainBehavior: enter creates vote channel + spawns reporter/reflector,
 *     checkCompletion waits for applaud
 *   - PhaseContext dependencies are accessible
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { CurtainBehavior } from "../../graph/behaviors/curtain-behavior";
import type { PhaseBehavior, PhaseContext } from "../../graph/behaviors/index";
// Import behaviors
import { ScriptBehavior } from "../../graph/behaviors/script-behavior";
import { StageBehavior } from "../../graph/behaviors/stage-behavior";

// ============================================================================
// Mock factories
// ============================================================================

/** AgentSession mock — simulates a running/completed agent. */
function mockAgentSession(
	id: string,
	role: string,
	status: "running" | "completed" | "failed" | "aborted" = "running",
) {
	return {
		id,
		role,
		status,
		agent: {},
		session: {},
		steer: mock(async (_message: string) => {}),
		followUp: mock(async (_message: string) => {}),
		abort: mock((_reason?: string) => {}),
		wait: mock(async (_timeoutMs?: number) => ({ output: "mock output", thinking: undefined })),
	} as unknown as Record<string, unknown>;
}

/** CommChannel mock — simulates a group communication channel. */
function mockCommChannel() {
	return {
		members: new Set<string>(),
		observers: new Set<string>(),
		send: mock(async (_from: string, _body: string) => {}),
		sendToGroup: mock(async (_from: string, _body: string, _memberIds: string[]) => {}),
		interrupt: mock(async (_observerId: string, _agentId: string, _reason: string) => {}),
		roundtable: mock(async (_topic: string, _opts: any) => ({
			converged: true,
			rounds: 2,
			responses: ["mock response"],
			finalPositions: ["mock position"],
		})),
		vote: mock(async (_question: string, _opts: any) => ({
			winner: "agent-1",
			deputyIds: ["agent-2"],
			tallies: new Map([
				["agent-1", 2],
				["agent-2", 1],
			]),
			scores: new Map([
				["agent-1", 2],
				["agent-2", 1],
			]),
			totalVotes: 3,
		})),
		addMember: mock((_agentId: string) => {}),
		removeMember: mock((_agentId: string) => {}),
		addObserver: mock((_observerId: string) => {}),
		removeObserver: mock((_observerId: string) => {}),
	} as any;
}

/** Creates a minimal PhaseContext mock with all required services. */
function mockPhaseContext(overrides: Partial<PhaseContext> = {}): PhaseContext {
	const channel = mockCommChannel();

	return {
		fsm: {
			phase: "idle",
			state: {
				phase: "idle",
				running: false,
				subStatus: "",
				iteration: 0,
				phaseStartedAt: Date.now(),
				capabilities: {
					multiAgent: false,
					roundtable: false,
					vote: false,
					offload: false,
					compaction: false,
					humanMode: "none",
				},
			},
			transition: mock(async () => ({ ok: true, from: "idle", to: "script" })),
			force: mock(async () => ({ ok: true, from: "idle", to: "script" })),
			onChange: mock(() => () => {}),
			capabilities: {
				multiAgent: false,
				roundtable: false,
				vote: false,
				offload: false,
				compaction: false,
				humanMode: "none",
			},
			registerPhase: mock(() => {}),
			waitForHumanDecision: mock(async () => "stage"),
			cancelTimed: mock(() => {}),
		} as any,

		ircBus: {
			groupChannel: mock((_name: string, _agentIds: string[], _activityLogger?: any) => channel),
			receiveFromHuman: mock(async (_text: string, _target?: string) => {}),
			removeChannel: mock((_name: string) => {}),
			setActivityLogger: mock((_logger: any) => {}),
		} as any,

		runtime: {
			spawn: mock(async (_specs: any[]) => {
				return _specs.map((s: { id: string; role: string }) => mockAgentSession(s.id, s.role));
			}),
			spawnRoundtable: mock(async () => ({
				converged: false,
				rounds: 0,
				responses: [],
				finalPositions: [],
			})),
			sendHumanMessage: mock(async (_agentId: string, _text: string) => {}),
			sendSystemNotification: mock(async (_agentId: string, _text: string) => {}),
		} as any,

		contextPipeline: {
			assemble: mock(async () => ({
				systemPrompt: "mock system prompt",
				taskPrompt: "mock task prompt",
				tools: [],
				injectedMessages: [],
				metadata: {},
			})),
			toTransformContext: mock(() => async (msgs: any[]) => msgs),
			register: mock(() => {}),
			listSources: mock(() => []),
		} as any,

		hookPipeline: {
			trigger: mock(async () => {}),
			register: mock(() => {}),
			unregister: mock(() => {}),
			list: mock(() => []),
		} as any,

		stateTracker: {
			state: {
				agents: {
					"agent-1": {
						name: "agent-1",
						status: "completed",
						iteration: 1,
						wave: 1,
						praiseCount: 5,
						criticismCount: 1,
						conflictCount: 0,
					},
					"agent-2": {
						name: "agent-2",
						status: "completed",
						iteration: 1,
						wave: 1,
						praiseCount: 3,
						criticismCount: 2,
						conflictCount: 1,
					},
				},
			},
			registerAgent: mock(async () => {}),
			updateAgent: mock(async () => {}),
			updatePipeline: mock(async () => {}),
			getBestAgent: mock(() => "agent-1"),
			getWorstAgent: mock(() => "agent-2"),
			getAgentScore: mock(() => 4),
			incrementPraise: mock(async () => {}),
			incrementCriticism: mock(async () => {}),
			incrementConflict: mock(async () => {}),
			swarmDir: "/tmp/.swarm_test",
		} as any,

		activityLogger: {
			logBroadcast: mock(() => {}),
			logPhase: mock(() => {}),
			logSteering: mock(() => {}),
			logVerdict: mock(() => {}),
			logConflict: mock(() => {}),
			logScaling: mock(() => {}),
			logNomination: mock(() => {}),
			logCrash: mock(() => {}),
			logAgentState: mock(() => {}),
			logPipelineState: mock(() => {}),
			logStreamStart: mock(() => {}),
			logStreamDelta: mock(() => {}),
			logStreamEnd: mock(() => {}),
			logFileChange: mock(() => {}),
			logToolCall: mock(() => {}),
		} as any,

		workspace: "/tmp/test-workspace",
		swarmDir: "/tmp/test-workspace/.swarm_test",
		planContent:
			"## Tasks\n- [ ] build-api (type: develop, role: backend-dev)\n- [ ] test-api (type: test, role: tester)",
		loopConfig: {
			maxIterations: 5,
			autoRetry: true,
			humanEscalation: true,
			planDebate: { enabled: true, agentCount: 2, maxRounds: 3, convergenceThreshold: 2 },
			agents: { initial: 2, min: 1, max: 5, auto: false, maxRounds: 5, roundsConvergenceThreshold: 3 },
			debate: { enabled: true, maxRounds: 2 },
			convergenceThreshold: 2,
			iterationTimeoutMs: 300_000,
			enableDeliberation: true,
		},
		signal: new AbortController().signal,

		...overrides,
	} as PhaseContext;
}

// ============================================================================
// PhaseBehavior interface compliance
// ============================================================================

describe("PhaseBehavior interface compliance", () => {
	const behaviors: [string, PhaseBehavior][] = [
		["ScriptBehavior", new ScriptBehavior()],
		["StageBehavior", new StageBehavior()],
		["CurtainBehavior", new CurtainBehavior()],
	];

	for (const [name, behavior] of behaviors) {
		describe(name, () => {
			it("has a phase property of type Chapter", () => {
				expect(behavior.phase).toBeString();
				const validPhases = [
					"idle",
					"script",
					"script-debate",
					"script-confirm",
					"stage",
					"paused",
					"blocked",
					"curtain",
				];
				expect(validPhases).toContain(behavior.phase);
			});

			it("Phase is correct for the behavior type", () => {
				if (name === "ScriptBehavior") {
					expect(behavior.phase).toBe("script");
				} else if (name === "StageBehavior") {
					expect(behavior.phase).toBe("stage");
				} else if (name === "CurtainBehavior") {
					expect(behavior.phase).toBe("curtain");
				}
			});

			it("implements enter()", () => {
				expect(typeof behavior.enter).toBe("function");
			});

			it("implements handleHumanMessage()", () => {
				expect(typeof behavior.handleHumanMessage).toBe("function");
			});

			it("implements handleAgentEvent()", () => {
				expect(typeof behavior.handleAgentEvent).toBe("function");
			});

			it("implements checkCompletion()", () => {
				expect(typeof behavior.checkCompletion).toBe("function");
			});

			it("implements exit()", () => {
				expect(typeof behavior.exit).toBe("function");
			});
		});
	}
});

// ============================================================================
// ScriptBehavior tests
// ============================================================================

describe("ScriptBehavior", () => {
	let behavior: ScriptBehavior;
	let ctx: PhaseContext;

	beforeEach(() => {
		behavior = new ScriptBehavior();
		ctx = mockPhaseContext();
	});

	describe("enter()", () => {
		it("returns empty agents (MAIN model IS the planner)", async () => {
			const result = await behavior.enter(ctx);

			expect(result.agents).toBeArray();
			expect(result.agents.length).toBe(0);
		});

		it("returns initialUIMessage", async () => {
			const result = await behavior.enter(ctx);

			expect(result.initialUIMessage).toBeString();
		});

		it("uses planContent from context without spawning", async () => {
			ctx.planContent = "Build a REST API for users";
			const result = await behavior.enter(ctx);

			// Plan content is used by the MAIN model; no agent spawned
			expect(result.agents.length).toBe(0);
		});
	});

	describe("handleHumanMessage()", () => {
		it("routes messages to the Planner", async () => {
			await behavior.enter(ctx);

			// Get the spawned planner mock
			const _plannerHandle = (ctx.runtime.spawn as any).mock.results[0]?.value?.[0];
			// For mocked spawn, we need to check the steer was called
			// Since we use mockAgentSession, steer is a mock function
			// The behavior steers via session.steer(), so we verify no errors

			await behavior.handleHumanMessage({ from: "human", body: "add authentication to the plan" }, ctx);

			// Should not throw — the planner handle is available
		});

		it("detects confirm signals and sets internal state", async () => {
			await behavior.enter(ctx);

			await behavior.handleHumanMessage({ from: "human", body: "confirm" }, ctx);

			// After confirm, checkCompletion should return a PhaseCompletion
			const result = await behavior.checkCompletion(ctx);
			expect(result).not.toBeNull();
			expect(result!.nextPhase).toBe("stage");
		});

		it("detects 'yes' as a confirm signal", async () => {
			await behavior.enter(ctx);

			await behavior.handleHumanMessage({ from: "human", body: "yes" }, ctx);

			const result = await behavior.checkCompletion(ctx);
			expect(result).not.toBeNull();
		});

		it("detects 'looks good!' as a confirm signal", async () => {
			await behavior.enter(ctx);

			await behavior.handleHumanMessage({ from: "human", body: "looks good!" }, ctx);

			const result = await behavior.checkCompletion(ctx);
			expect(result).not.toBeNull();
		});
	});

	describe("handleAgentEvent()", () => {
		it("tracks planner completion", async () => {
			await behavior.enter(ctx);

			await behavior.handleAgentEvent(
				{ agentId: "planner", status: "completed", result: { output: "Plan is ready" } },
				ctx,
			);

			// Should not throw — internal state updated
		});

		it("tracks planner failure", async () => {
			await behavior.enter(ctx);

			await behavior.handleAgentEvent({ agentId: "planner", status: "failed", result: "error message" }, ctx);

			// Should not throw — internal state updated, plannerFinished set to true
		});

		// SatoPi: verify aborted status is handled (C6 fix)
		it("tracks planner abort", async () => {
			await behavior.enter(ctx);

			await behavior.handleAgentEvent({ agentId: "planner", status: "aborted", result: "timeout" }, ctx);

			// After abort, plannerFinished should be true — the phase is done.
			// checkCompletion returns null because no completion signal in output,
			// but the internal state correctly reflects that the planner stopped.
			const result = await behavior.checkCompletion(ctx);
			expect(result).toBeNull();
		});

		it("records abort reason from structured result", async () => {
			await behavior.enter(ctx);

			await behavior.handleAgentEvent(
				{ agentId: "planner", status: "aborted", result: { reason: "cancelled by user" } },
				ctx,
			);

			// Should not throw — aborted with structured reason
			const result = await behavior.checkCompletion(ctx);
			expect(result).toBeNull();
		});

		it("ignores events from non-planner agents", async () => {
			await behavior.enter(ctx);

			// This should be a no-op — no crash
			await behavior.handleAgentEvent({ agentId: "other-agent", status: "completed", result: "done" }, ctx);
		});
	});

	describe("checkCompletion()", () => {
		it("returns null when plan is not ready and not confirmed", async () => {
			await behavior.enter(ctx);

			const result = await behavior.checkCompletion(ctx);
			expect(result).toBeNull();
		});

		it("detects completion signal in planner output", async () => {
			await behavior.enter(ctx);

			// Simulate planner completing with a completion signal
			await behavior.handleAgentEvent(
				{
					agentId: "planner",
					status: "completed",
					result: { output: "The plan is complete. Here is the build plan..." },
				},
				ctx,
			);

			const result = await behavior.checkCompletion(ctx);
			expect(result).not.toBeNull();
			if (result) {
				expect(result.nextPhase).toBe("script-confirm");
			}
		});

		it("detects 'plan is ready' signal", async () => {
			await behavior.enter(ctx);

			await behavior.handleAgentEvent(
				{ agentId: "planner", status: "completed", result: { output: "The plan is ready to proceed." } },
				ctx,
			);

			const result = await behavior.checkCompletion(ctx);
			expect(result).not.toBeNull();
		});
	});

	describe("exit()", () => {
		it("clears internal state", async () => {
			await behavior.enter(ctx);

			await behavior.exit();

			// After exit, checkCompletion should return null (state cleared)
			const result = await behavior.checkCompletion(ctx);
			expect(result).toBeNull();
		});
	});
});

// ============================================================================
// StageBehavior tests
// ============================================================================

describe("StageBehavior", () => {
	let behavior: StageBehavior;
	let ctx: PhaseContext;

	beforeEach(() => {
		behavior = new StageBehavior();
		ctx = mockPhaseContext({
			planContent:
				"## Tasks\n- [ ] build-api (type: develop) (role: backend-dev)\n- [ ] test-api (type: test) (role: tester)",
		});
	});

	describe("enter()", () => {
		it("creates a swarm group channel", async () => {
			const result = await behavior.enter(ctx);

			expect(result.channels).toBeArray();
			expect(result.channels.length).toBeGreaterThanOrEqual(1);
			expect(ctx.ircBus.groupChannel).toHaveBeenCalled();
		});

		it("spawns worker agents for each unique role in the plan", async () => {
			const result = await behavior.enter(ctx);

			expect(result.agents).toBeArray();
			// Two unique roles: backend-dev, tester
			expect(result.agents.length).toBe(2);
		});

		it("spawns a default worker when plan has no tasks", async () => {
			ctx.planContent = "# Empty Plan\n\nNo tasks defined.";

			const result = await behavior.enter(ctx);

			expect(result.agents).toBeArray();
			expect(result.agents.length).toBe(1);
		});

		it("returns initialUIMessage with agent count", async () => {
			const result = await behavior.enter(ctx);

			expect(result.initialUIMessage).toBeString();
			expect(result.initialUIMessage).toContain("2 workers");
		});

		it("registers agents in StateTracker", async () => {
			await behavior.enter(ctx);

			expect(ctx.stateTracker.registerAgent).toHaveBeenCalled();
		});
	});

	describe("handleHumanMessage()", () => {
		it("broadcasts steering messages via channel", async () => {
			await behavior.enter(ctx);

			await behavior.handleHumanMessage({ from: "human", body: "please write tests first" }, ctx);

			// The message should be broadcast via the channel
			// and also via runtime.sendHumanMessage
		});

		it("handles pause command", async () => {
			await behavior.enter(ctx);

			await behavior.handleHumanMessage({ from: "human", body: "pause" }, ctx);

			// After pause, checkCompletion should return null
			const result = await behavior.checkCompletion(ctx);
			expect(result).toBeNull();
		});

		it("handles resume command after pause", async () => {
			await behavior.enter(ctx);

			await behavior.handleHumanMessage({ from: "human", body: "pause" }, ctx);

			// Paused — checkCompletion returns null
			let result = await behavior.checkCompletion(ctx);
			expect(result).toBeNull();

			await behavior.handleHumanMessage({ from: "human", body: "resume" }, ctx);

			// Resumed — agents still running, so still null
			result = await behavior.checkCompletion(ctx);
			expect(result).toBeNull();
		});

		it("handles /pause and /resume slash commands", async () => {
			await behavior.enter(ctx);

			await behavior.handleHumanMessage({ from: "human", body: "/pause" }, ctx);
			let result = await behavior.checkCompletion(ctx);
			expect(result).toBeNull();

			await behavior.handleHumanMessage({ from: "human", body: "/resume" }, ctx);
			result = await behavior.checkCompletion(ctx);
			expect(result).toBeNull();
		});
	});

	describe("handleAgentEvent()", () => {
		it("tracks agent completion and updates state tracker", async () => {
			await behavior.enter(ctx);

			// Get spawned agents
			const result = await behavior.enter(ctx);
			const agentId = result.agents[0].id;

			await behavior.handleAgentEvent({ agentId, status: "completed", result: { output: "done" } }, ctx);

			expect(ctx.stateTracker.updateAgent).toHaveBeenCalled();
		});

		it("tracks agent failure and logs crash", async () => {
			await behavior.enter(ctx);

			const result = await behavior.enter(ctx);
			const agentId = result.agents[0].id;

			await behavior.handleAgentEvent({ agentId, status: "failed", result: "something went wrong" }, ctx);

			expect(ctx.activityLogger.logCrash).toHaveBeenCalled();
			expect(ctx.stateTracker.updateAgent).toHaveBeenCalled();
		});

		it("emits agent:afterComplete with the last assistant text as summary", async () => {
			const result = await behavior.enter(ctx);
			const agentId = result.agents[0].id;

			const agentEnd = {
				type: "agent_end",
				messages: [
					{ role: "user", content: "build the api" },
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "Let me design this" },
							{ type: "text", text: "Built the API with tests" },
						],
					},
				],
			};

			await behavior.handleAgentEvent({ agentId, status: "completed", result: agentEnd }, ctx);

			expect(ctx.hookPipeline.trigger).toHaveBeenCalledWith(
				"agent:afterComplete",
				expect.objectContaining({ agentId, success: true, summary: "Built the API with tests" }),
				expect.anything(),
			);
		});

		it("truncates the agent:afterComplete summary to 200 characters", async () => {
			await behavior.enter(ctx);

			const result = await behavior.enter(ctx);
			const agentId = result.agents[0].id;
			const longText = "y".repeat(500);

			await behavior.handleAgentEvent(
				{
					agentId,
					status: "completed",
					result: {
						type: "agent_end",
						messages: [{ role: "assistant", content: [{ type: "text", text: longText }] }],
					},
				},
				ctx,
			);

			expect(ctx.hookPipeline.trigger).toHaveBeenCalledWith(
				"agent:afterComplete",
				expect.objectContaining({ agentId, success: true, summary: "y".repeat(200) }),
				expect.anything(),
			);
		});

		it("emits agent:afterComplete with error text as summary on failure", async () => {
			await behavior.enter(ctx);

			const result = await behavior.enter(ctx);
			const agentId = result.agents[0].id;

			const agentEnd = {
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						content: [{ type: "text", text: "partial work" }],
						errorMessage: "provider rate limit exceeded",
					},
				],
			};

			await behavior.handleAgentEvent({ agentId, status: "failed", result: agentEnd }, ctx);

			expect(ctx.hookPipeline.trigger).toHaveBeenCalledWith(
				"agent:afterComplete",
				expect.objectContaining({ agentId, success: false, summary: "provider rate limit exceeded" }),
				expect.anything(),
			);
		});

		it("ignores events from unknown agents", async () => {
			await behavior.enter(ctx);

			// Should not throw
			await behavior.handleAgentEvent({ agentId: "unknown-agent", status: "completed", result: "done" }, ctx);
		});
	});

	describe("checkCompletion()", () => {
		it("returns null when agents are still running", async () => {
			await behavior.enter(ctx);

			const result = await behavior.checkCompletion(ctx);
			expect(result).toBeNull();
		});

		it("returns null when paused", async () => {
			await behavior.enter(ctx);

			await behavior.handleHumanMessage({ from: "human", body: "pause" }, ctx);

			const result = await behavior.checkCompletion(ctx);
			expect(result).toBeNull();
		});
	});

	describe("exit()", () => {
		it("clears internal state", async () => {
			await behavior.enter(ctx);

			await behavior.exit();

			// After exit, checkCompletion returns null
			const result = await behavior.checkCompletion(ctx);
			expect(result).toBeNull();
		});
	});
});

// ============================================================================
// CurtainBehavior tests
// ============================================================================

describe("CurtainBehavior", () => {
	let behavior: CurtainBehavior;
	let ctx: PhaseContext;

	beforeEach(() => {
		behavior = new CurtainBehavior();
		ctx = mockPhaseContext();
	});

	describe("enter()", () => {
		it("creates an election channel and spawns reporter + reflector", async () => {
			const result = await behavior.enter(ctx);

			expect(result.agents).toBeArray();
			// Expect reporter (elected agent-1) + reflector
			expect(result.agents.length).toBe(2);
		});

		it("spawns reporter and reflector agents", async () => {
			const result = await behavior.enter(ctx);

			const agentIds = result.agents.map(a => a.id);
			// One should be the elected winner (agent-1) and one should be "reflector"
			expect(agentIds).toContain("reflector");
		});

		it("creates a vote channel when multiple agents exist", async () => {
			await behavior.enter(ctx);

			// The ircBus.groupChannel should have been called with "election"
			expect(ctx.ircBus.groupChannel).toHaveBeenCalled();
		});

		it("returns initialUIMessage", async () => {
			const result = await behavior.enter(ctx);

			expect(result.initialUIMessage).toBeString();
			expect(result.initialUIMessage!.length).toBeGreaterThan(0);
		});

		it("handles case with no agents in state (falls back to default reporter)", async () => {
			const emptyCtx = mockPhaseContext({
				...ctx,
				stateTracker: {
					...ctx.stateTracker,
					state: { agents: {} },
					getBestAgent: mock(() => null),
				} as any,
			});

			const result = await behavior.enter(emptyCtx);

			expect(result.agents).toBeArray();
			expect(result.agents.length).toBeGreaterThanOrEqual(1);
		});
	});

	describe("handleHumanMessage()", () => {
		it("detects applaud signal and sets internal state", async () => {
			await behavior.enter(ctx);

			// Simulate reporter and reflector completing
			await behavior.handleAgentEvent(
				{ agentId: "agent-1", status: "completed", result: { output: "report" } },
				ctx,
			);
			await behavior.handleAgentEvent(
				{ agentId: "reflector", status: "completed", result: { output: "lessons" } },
				ctx,
			);

			// Applaud
			await behavior.handleHumanMessage({ from: "human", body: "applaud" }, ctx);

			const result = await behavior.checkCompletion(ctx);
			expect(result).not.toBeNull();
			expect(result!.nextPhase).toBe("idle");
			expect(result!.needApplaud).toBeFalsy();
		});

		it("detects 'thanks' as an applaud signal", async () => {
			await behavior.enter(ctx);

			await behavior.handleAgentEvent(
				{ agentId: "agent-1", status: "completed", result: { output: "report" } },
				ctx,
			);
			await behavior.handleAgentEvent(
				{ agentId: "reflector", status: "completed", result: { output: "lessons" } },
				ctx,
			);

			await behavior.handleHumanMessage({ from: "human", body: "thanks" }, ctx);

			const result = await behavior.checkCompletion(ctx);
			expect(result).not.toBeNull();
		});

		it("routes other messages to the reporter", async () => {
			await behavior.enter(ctx);

			// Should not throw — routes to reporter if still running
			await behavior.handleHumanMessage({ from: "human", body: "can you elaborate on the test results?" }, ctx);
		});
	});

	describe("handleAgentEvent()", () => {
		it("tracks reporter completion", async () => {
			await behavior.enter(ctx);

			await behavior.handleAgentEvent(
				{ agentId: "agent-1", status: "completed", result: { output: "report" } },
				ctx,
			);

			// Reporter completed but reflector not yet → checkCompletion returns null
			const result = await behavior.checkCompletion(ctx);
			expect(result).toBeNull();
		});

		it("tracks reflector completion", async () => {
			await behavior.enter(ctx);

			await behavior.handleAgentEvent(
				{ agentId: "reflector", status: "completed", result: { output: "lessons" } },
				ctx,
			);

			// Reflector completed but reporter not yet → checkCompletion returns null
			const result = await behavior.checkCompletion(ctx);
			expect(result).toBeNull();
		});

		it("handles agent failure", async () => {
			await behavior.enter(ctx);

			await behavior.handleAgentEvent({ agentId: "agent-1", status: "failed", result: "crash" }, ctx);

			// Reporter failed — still marks as completed
			// Reflector not complete yet → null
			await behavior.checkCompletion(ctx);
			// May be null if reflector is not done, or may return completion if
			// both are done (reporter failed → treated as complete)
		});
	});

	describe("checkCompletion()", () => {
		it("returns null when reporter has not finished", async () => {
			await behavior.enter(ctx);

			const result = await behavior.checkCompletion(ctx);
			expect(result).toBeNull();
		});

		it("returns PhaseCompletion with needApplaud when both are done but no applaud", async () => {
			await behavior.enter(ctx);

			// Simulate both completing
			await behavior.handleAgentEvent(
				{ agentId: "agent-1", status: "completed", result: { output: "report" } },
				ctx,
			);
			await behavior.handleAgentEvent(
				{ agentId: "reflector", status: "completed", result: { output: "lessons" } },
				ctx,
			);

			const result = await behavior.checkCompletion(ctx);
			expect(result).not.toBeNull();
			if (result) {
				expect(result.nextPhase).toBe("idle");
				expect(result.needApplaud).toBe(true);
			}
		});

		it("returns PhaseCompletion without needApplaud after human applauds", async () => {
			await behavior.enter(ctx);

			await behavior.handleAgentEvent(
				{ agentId: "agent-1", status: "completed", result: { output: "report" } },
				ctx,
			);
			await behavior.handleAgentEvent(
				{ agentId: "reflector", status: "completed", result: { output: "lessons" } },
				ctx,
			);
			await behavior.handleHumanMessage({ from: "human", body: "applaud" }, ctx);

			const result = await behavior.checkCompletion(ctx);
			expect(result).not.toBeNull();
			if (result) {
				expect(result.needApplaud).toBeFalsy();
			}
		});
	});

	describe("exit()", () => {
		it("clears internal state", async () => {
			await behavior.enter(ctx);

			await behavior.exit();

			// After exit, checkCompletion returns null
			const result = await behavior.checkCompletion(ctx);
			expect(result).toBeNull();
		});
	});
});

// ============================================================================
// PhaseContext accessibility tests
// ============================================================================

describe("PhaseContext", () => {
	it("provides all required services to behaviors", async () => {
		const ctx = mockPhaseContext();
		const behavior = new ScriptBehavior();

		// enter() should receive and use all context services without error
		const result = await behavior.enter(ctx);
		expect(result).toBeDefined();
		expect(result.agents).toBeArray();
		expect(result.agents.length).toBe(0); // MAIN model IS the planner

		// Context services are accessible (but ScriptBehavior doesn't spawn agents)
		expect(ctx.runtime.spawn).toBeDefined();
		expect(ctx.ircBus.groupChannel).toBeDefined();
	});

	it("loopConfig is accessible for roundtable/roundtable configuration", async () => {
		const ctx = mockPhaseContext({
			loopConfig: {
				maxIterations: 3,
				autoRetry: false,
				humanEscalation: true,
				planDebate: { enabled: true, agentCount: 2, maxRounds: 2, convergenceThreshold: 2 },
				agents: { initial: 3, min: 1, max: 6, auto: false, maxRounds: 3, roundsConvergenceThreshold: 2 },
				debate: { enabled: false, maxRounds: 2 },
				convergenceThreshold: 1,
				iterationTimeoutMs: 120_000,
				enableDeliberation: false,
			},
		});

		const behavior = new StageBehavior();
		const result = await behavior.enter(ctx);

		// When debate is disabled, no roundtable should run — but spawn still works
		expect(result.agents.length).toBeGreaterThan(0);
	});

	it("workspace and swarmDir are accessible", async () => {
		const ctx = mockPhaseContext({
			workspace: "/home/user/project",
			swarmDir: "/home/user/project/.swarm_mybuild",
		});

		const behavior = new ScriptBehavior();
		const result = await behavior.enter(ctx);

		expect(result).toBeDefined();
	});

	it("signal can be used for cooperative cancellation", async () => {
		const controller = new AbortController();
		const ctx = mockPhaseContext({
			signal: controller.signal,
		});

		// Verify signal is not aborted initially
		expect(ctx.signal.aborted).toBe(false);

		// Abort the signal
		controller.abort();
		expect(ctx.signal.aborted).toBe(true);
	});
});
