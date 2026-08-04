/**
 * GraphRunner hook-wiring tests — P0 lifecycle event contract, Slice A.
 *
 * The runner pulls its hook pipeline from the swarm infra (graph-runner.ts
 * init: `this.#hookPipeline = infra.hookPipeline`), so these tests inject a
 * recording mock pipeline through a fully-mocked infra and assert:
 *   1. Every phase transition emits workflow:beforePhase before the
 *      `#phase = next` assignment (observed via onPhaseChange, which runs
 *      after the assignment) and workflow:afterPhase after it, with the
 *      actual phase value in both payload and ctx.
 *   2. The curtain → idle transition emits the same pair.
 *   3. agent_end with stopReason "error"/"aborted" emits agent:onError with
 *      a { agentId, error } payload and a { phase, agentId } ctx.
 */
import { describe, expect, it, mock } from "bun:test";
import type { HookContext } from "../../hooks/types";
import type { AgentSession } from "../../session/agent/agent-session";
import type { StateTracker } from "../../swarm/core/state";
import type { SwarmInfra } from "../../swarm/core/swarm-infra";
import { GraphRunner } from "../graph-runner";

/** A single recorded hook trigger or onPhaseChange call, in emission order. */
interface RecordedEvent {
	event: string;
	payload: { phase?: unknown; agentId?: string; error?: string };
	ctx: HookContext;
}

/** A mock AgentSession whose subscribe callback the test can drive manually. */
interface MockAgentSession {
	session: AgentSession;
	emit: (event: unknown) => void;
}

function makeAgentSession(id: string, role: string): MockAgentSession {
	const listeners: Array<(event: unknown) => void> = [];
	const session = {
		id,
		role,
		status: "idle",
		subscribe: (cb: (event: unknown) => void): (() => void) => {
			listeners.push(cb);
			return () => {
				const index = listeners.indexOf(cb);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		abort: mock(),
	} as unknown as AgentSession;
	return {
		session,
		emit: event => {
			for (const cb of [...listeners]) cb(event);
		},
	};
}

/** Assistant message shaped enough for the runner's stopReason/errorMessage scan. */
function assistantMessage(stopReason: string, errorMessage?: string): Record<string, unknown> {
	return {
		role: "assistant",
		content: [],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {},
		stopReason,
		...(errorMessage !== undefined ? { errorMessage } : {}),
		timestamp: 0,
	};
}

function agentEndEvent(messages: unknown[]): Record<string, unknown> {
	return { type: "agent_end", messages };
}

/** GraphRunner test harness: recording hook pipeline + fully mocked infra. */
interface GraphRunnerHarness {
	runner: GraphRunner;
	events: RecordedEvent[];
	reporter: MockAgentSession;
	reflector: MockAgentSession;
}

function createHarness(): GraphRunnerHarness {
	const events: RecordedEvent[] = [];
	const reporter = makeAgentSession("reporter", "reporter");
	const reflector = makeAgentSession("reflector", "reflector");

	const hookPipeline = {
		trigger: mock(async (event: string, payload: RecordedEvent["payload"], ctx: HookContext) => {
			events.push({ event, payload, ctx });
		}),
	};

	const stateTracker = {
		state: { phase: "idle", agents: {} },
		updatePipeline: mock().mockResolvedValue(undefined),
		updateAgent: mock(),
		getBestAgent: mock(),
	} as unknown as StateTracker;

	const infra = {
		sessionManager: { appendCustomEntry: mock(), storage: {} },
		stateTracker,
		activityLogger: { logPhase: mock(), logCrash: mock(), logNomination: mock() },
		experienceStore: { close: mock() },
		hookPipeline,
		runtime: {
			spawn: mock().mockResolvedValue([reporter.session, reflector.session]),
			contextPipeline: {},
			ircBus: { receiveFromHuman: mock() },
		},
		roleAssetManager: {},
		markEnvironment: {},
		offloadManager: {},
		ircBus: {},
	} as unknown as SwarmInfra;

	const runner = new GraphRunner({
		workspace: "/tmp/graph-runner-hooks-test",
		modelRegistry: {} as never,
		settings: {} as never,
		infra,
		autoApplaud: true,
		onPhaseChange: phase => {
			events.push({ event: "onPhaseChange", payload: { phase }, ctx: {} });
		},
		readSessionEntries: mock().mockResolvedValue([]),
	});

	return { runner, events, reporter, reflector };
}

function sleep(ms: number): Promise<void> {
	return Bun.sleep(ms);
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
		await sleep(50);
	}
}

describe("GraphRunner hook wiring", () => {
	it("emits workflow:beforePhase/afterPhase around each phase transition in order", async () => {
		const { runner, events, reporter, reflector } = createHarness();
		await runner.init();

		// confirmScript drives the full lifecycle: stage → curtain → idle.
		const runPromise = runner.confirmScript();

		// Wait for the stage transition, then complete both curtain agents so
		// the lifecycle (which polls every 750ms) can move on to idle.
		await waitFor(() => events.some(e => e.event === "workflow:afterPhase" && e.payload.phase === "stage"));
		reporter.emit(agentEndEvent([assistantMessage("stop")]));
		reflector.emit(agentEndEvent([assistantMessage("stop")]));

		await waitFor(() => events.some(e => e.event === "workflow:afterPhase" && e.payload.phase === "idle"));
		await runPromise;

		// For every transition: beforePhase fires first, then onPhaseChange
		// (which the runner calls after `#phase = next`), then afterPhase —
		// proving beforePhase precedes the assignment and afterPhase follows it.
		expect(events.map(e => `${e.event}:${String(e.payload.phase)}`)).toEqual([
			"workflow:beforePhase:stage",
			"onPhaseChange:stage",
			"workflow:afterPhase:stage",
			"workflow:beforePhase:curtain",
			"onPhaseChange:curtain",
			"workflow:afterPhase:curtain",
			"workflow:beforePhase:idle",
			"onPhaseChange:idle",
			"workflow:afterPhase:idle",
		]);

		// Payload and ctx must both carry the actual (non-undefined) phase.
		for (const e of events.filter(e => e.event.startsWith("workflow:"))) {
			expect(e.payload.phase).toBeDefined();
			expect(e.payload.phase).toBe(e.ctx.phase);
		}
	});

	it("emits agent:onError when an agent ends with stopReason error or aborted", async () => {
		const { runner, events, reporter, reflector } = createHarness();
		await runner.init();

		const runPromise = runner.confirmScript();

		// Agents are wired during the curtain transition.
		await waitFor(() => events.some(e => e.event === "workflow:afterPhase" && e.payload.phase === "curtain"));

		// stopReason "error" → status "failed" → agent:onError with the error text.
		reporter.emit(agentEndEvent([assistantMessage("error", "simulated provider failure")]));
		// stopReason "aborted" → status "aborted" → agent:onError (stop reason fallback).
		reflector.emit(agentEndEvent([assistantMessage("aborted")]));

		await waitFor(() => events.filter(e => e.event === "agent:onError").length === 2);

		const errorEvents = events.filter(e => e.event === "agent:onError");
		expect(errorEvents).toHaveLength(2);

		expect(errorEvents[0].payload.agentId).toBe("reporter");
		expect(errorEvents[0].payload.error).toBe("simulated provider failure");
		expect(errorEvents[0].ctx.phase).toBe("curtain");
		expect(errorEvents[0].ctx.agentId).toBe("reporter");

		expect(errorEvents[1].payload.agentId).toBe("reflector");
		expect(errorEvents[1].payload.error).toBe("aborted");
		expect(errorEvents[1].ctx.phase).toBe("curtain");
		expect(errorEvents[1].ctx.agentId).toBe("reflector");

		// Tear down the pending curtain lifecycle.
		await runner.dispose();
		await runPromise;
	});
});
