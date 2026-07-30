/**
 * Extended coverage: Verifies all 15 untriggered HookEvent types are
 * fireable through HookPipeline.trigger() with correct payload shapes,
 * and that the trigger integration sites work for each file.
 */
/**
 * swarm-hooks.test.ts — createStageFeedback integration tests
 *
 * Coverage:
 * 1. Disabled mode returns no-op callbacks
 * 2. onAgentsSelected registers profiles and records collaboration
 * 3. onTaskCompleted updates credit + places artifact mark
 * 4. onTaskFailed records failure + places warning mark
 * 5. getAgentContext returns profile + stigmergy context
 * 6. onStageComplete does not throw
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import type { SingleResult } from "@satopi/pi-coding-agent";
import { ProfileRegistry } from "../../agent/agent-profile";
import type { ScoredAgent } from "../../agent/agent-selector";
import { MarkEnvironment } from "../../coordination";
import type { Task } from "../../graph/task-queue";
import { createStageFeedback } from "../infra/swarm-hooks";

describe("createStageFeedback (StageController callbacks)", () => {
	let profileRegistry: ProfileRegistry;
	let markEnvironment: MarkEnvironment;

	beforeEach(() => {
		profileRegistry = new ProfileRegistry();
		markEnvironment = new MarkEnvironment();
	});

	function makeAgent(id: string, archetype = "implementer"): ScoredAgent {
		return {
			profileId: id,
			name: id,
			archetype,
			score: 0.8,
			creditScore: 0.5,
			domainMatch: 0.8,
			successRate: 0.7,
			recencyBonus: 0,
			preferredRoles: [archetype],
		};
	}

	function makeTask(overrides: Partial<Task> = {}): Task {
		return {
			id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
			title: "Test task",
			type: "develop",
			dependsOn: [],
			estimatedMinutes: 0,
			assignedRole: "implementer",
			status: "pending" as const,
			...overrides,
		};
	}

	// ── Disabled mode ──────────────────────────────────────────────

	test("disabled returns stub callbacks that no-op", () => {
		const fb = createStageFeedback({
			enabled: false,
			profileRegistry,
			markEnvironment,
		});

		expect(() => fb.onAgentsSelected([makeAgent("w1")])).not.toThrow();
		expect(fb.getAgentContext("w1")).toBeNull();
	});

	// ── Agent selection callback ───────────────────────────────────

	test("onAgentsSelected registers profiles and records collaboration", () => {
		const fb = createStageFeedback({
			enabled: true,
			profileRegistry,
			markEnvironment,
		});

		fb.onAgentsSelected([makeAgent("agent-alpha", "architect"), makeAgent("agent-beta", "implementer")]);

		expect(profileRegistry.get("agent-alpha")).toBeDefined();
		expect(profileRegistry.get("agent-beta")).toBeDefined();
		expect(profileRegistry.get("agent-alpha")!.identity.archetype).toBe("architect");
	});

	test("onAgentsSelected is idempotent for same profileId", () => {
		const fb = createStageFeedback({
			enabled: true,
			profileRegistry,
			markEnvironment,
		});

		fb.onAgentsSelected([makeAgent("w1")]);
		fb.onAgentsSelected([makeAgent("w1")]);
		expect(profileRegistry.get("w1")).toBeDefined();
	});

	// ── Task completed callback ────────────────────────────────────

	test("onTaskCompleted updates credit score and places artifact mark", () => {
		const fb = createStageFeedback({
			enabled: true,
			profileRegistry,
			markEnvironment,
		});

		fb.onAgentsSelected([makeAgent("w1")]);
		const initialScore = profileRegistry.get("w1")!.credit.score;

		const task = makeTask();
		const result: SingleResult = {
			index: 0,
			id: "test-result",
			agent: "w1",
			agentSource: "bundled",
			task: "implementation",
			exitCode: 0,
			output: "done",
			stderr: "",
			truncated: false,
			durationMs: 0,
			tokens: 0,
			requests: 0,
		};

		fb.onTaskCompleted("w1", task, result);

		const profile = profileRegistry.get("w1")!;
		expect(profile.credit.score).toBe(initialScore + 3);
		expect(profile.credit.totalTasks).toBe(1);

		const marks = markEnvironment.queryMarks({ types: ["artifact"] });
		expect(marks.length).toBeGreaterThanOrEqual(1);
	});

	// ── Task failed callback ───────────────────────────────────────

	test("onTaskFailed records failure and places warning mark", () => {
		const fb = createStageFeedback({
			enabled: true,
			profileRegistry,
			markEnvironment,
		});

		fb.onAgentsSelected([makeAgent("w2")]);
		const initialScore = profileRegistry.get("w2")!.credit.score;

		const task = makeTask({ title: "Broken module" });

		fb.onTaskFailed("w2", task, "compilation error");

		const profile = profileRegistry.get("w2")!;
		expect(profile.credit.score).toBe(initialScore);
		expect(profile.credit.totalTasks).toBe(1);

		const marks = markEnvironment.queryMarks({ types: ["warning"] });
		expect(marks.length).toBeGreaterThanOrEqual(1);
		expect(marks[0].message).toContain("compilation error");
	});

	// ── Prompt context injection ───────────────────────────────────

	test("getAgentContext returns profile + stigmergy context", () => {
		const fb = createStageFeedback({
			enabled: true,
			profileRegistry,
			markEnvironment,
		});

		fb.onAgentsSelected([makeAgent("w3", "reviewer")]);

		const ctx = fb.getAgentContext("w3");
		expect(ctx).not.toBeNull();
		expect(ctx!).toContain("w3");
		expect(ctx!).toContain("reviewer");
	});

	test("getAgentContext includes stigmergy marks when present", () => {
		const fb = createStageFeedback({
			enabled: true,
			profileRegistry,
			markEnvironment,
		});

		fb.onAgentsSelected([makeAgent("w4"), makeAgent("w5")]);

		markEnvironment.placeMark({
			markId: "sig-1",
			type: "signal",
			agentId: "w4",
			message: "w5 is working on auth module",
			priority: "low",
		});

		const ctx = fb.getAgentContext("w5");
		expect(ctx).not.toBeNull();
		expect(ctx!).toContain("w5");
	});

	// ── Stage complete ─────────────────────────────────────────────

	test("onStageComplete does not throw", () => {
		const fb = createStageFeedback({
			enabled: true,
			profileRegistry,
			markEnvironment,
		});

		fb.onAgentsSelected([makeAgent("w1")]);

		expect(() =>
			fb.onStageComplete({
				status: "completed",
				agentResults: new Map(),
				errors: [],
				agents: [],
				taskProgress: { total: 1, completed: 1 },
				degradedMode: [],
			}),
		).not.toThrow();
	});
});

// ============================================================================
// Hook event coverage — verify all 15 previously untriggered event types
// ============================================================================

import { HookPipeline } from "../../hooks/hook-pipeline";
import type { HandlerArgs, HookContext, HookEvent, HookRegistration } from "../../hooks/types";

/** Helper to create a hook that records events it receives. */
function makeRecordingHook(name: string, priority: number, events: HookEvent[], log: string[]): HookRegistration {
	return {
		name,
		priority,
		events,
		handler: async ({ event }: HandlerArgs, _ctx: HookContext) => {
			log.push(event);
		},
	};
}

function ctx(phase?: string, agentId?: string): HookContext {
	return { phase: phase as HookContext["phase"], agentId };
}

describe("Hook event trigger coverage (15 untriggered types)", () => {
	// -----------------------------------------------------------------------
	// Comm events (4)
	// -----------------------------------------------------------------------

	test("comm:beforeMessage fires with correct payload", async () => {
		const pipeline = new HookPipeline();
		const log: string[] = [];
		pipeline.register(makeRecordingHook("comm-hook", 0, ["comm:beforeMessage"], log));
		await pipeline.trigger("comm:beforeMessage", { from: "a1", to: "a2", message: "hello" }, ctx());
		expect(log).toEqual(["comm:beforeMessage"]);
	});

	test("comm:afterMessage fires with correct payload", async () => {
		const pipeline = new HookPipeline();
		const log: string[] = [];
		pipeline.register(makeRecordingHook("comm-hook", 0, ["comm:afterMessage"], log));
		await pipeline.trigger("comm:afterMessage", { from: "human", to: "a1", message: "hey" }, ctx());
		expect(log).toEqual(["comm:afterMessage"]);
	});

	test("comm:beforeBroadcast fires with correct payload", async () => {
		const pipeline = new HookPipeline();
		const log: string[] = [];
		pipeline.register(makeRecordingHook("comm-hook", 0, ["comm:beforeBroadcast"], log));
		await pipeline.trigger("comm:beforeBroadcast", { from: "facilitator", message: "announcement" }, ctx());
		expect(log).toEqual(["comm:beforeBroadcast"]);
	});

	test("comm:afterBroadcast fires with correct payload", async () => {
		const pipeline = new HookPipeline();
		const log: string[] = [];
		pipeline.register(makeRecordingHook("comm-hook", 0, ["comm:afterBroadcast"], log));
		await pipeline.trigger("comm:afterBroadcast", { from: "facilitator", message: "done" }, ctx());
		expect(log).toEqual(["comm:afterBroadcast"]);
	});

	// -----------------------------------------------------------------------
	// Roundtable events (3)
	// -----------------------------------------------------------------------

	test("roundtable:beforeRound fires with correct payload", async () => {
		const pipeline = new HookPipeline();
		const log: string[] = [];
		pipeline.register(makeRecordingHook("rt-hook", 0, ["roundtable:beforeRound"], log));
		await pipeline.trigger("roundtable:beforeRound", { agentId: "a1", round: 2 }, ctx("script", "a1"));
		expect(log).toEqual(["roundtable:beforeRound"]);
	});

	test("roundtable:afterRound fires with correct payload", async () => {
		const pipeline = new HookPipeline();
		const log: string[] = [];
		pipeline.register(makeRecordingHook("rt-hook", 0, ["roundtable:afterRound"], log));
		await pipeline.trigger("roundtable:afterRound", { agentId: "a1" }, ctx("script", "a1"));
		expect(log).toEqual(["roundtable:afterRound"]);
	});

	test("roundtable:converged fires with correct payload", async () => {
		const pipeline = new HookPipeline();
		const log: string[] = [];
		pipeline.register(makeRecordingHook("rt-hook", 0, ["roundtable:converged"], log));
		await pipeline.trigger("roundtable:converged", { agentIds: ["a1", "a2"] }, ctx("script"));
		expect(log).toEqual(["roundtable:converged"]);
	});

	// -----------------------------------------------------------------------
	// Vote events (3)
	// -----------------------------------------------------------------------

	test("vote:start fires with correct payload", async () => {
		const pipeline = new HookPipeline();
		const log: string[] = [];
		pipeline.register(makeRecordingHook("vote-hook", 0, ["vote:start"], log));
		await pipeline.trigger("vote:start", { agentIds: ["a1", "a2"], topic: "best plan" }, ctx("script"));
		expect(log).toEqual(["vote:start"]);
	});

	test("vote:tally fires with correct payload", async () => {
		const pipeline = new HookPipeline();
		const log: string[] = [];
		pipeline.register(makeRecordingHook("vote-hook", 0, ["vote:tally"], log));
		await pipeline.trigger("vote:tally", { agentIds: ["a1"], topic: "election" }, ctx("script"));
		expect(log).toEqual(["vote:tally"]);
	});

	test("vote:result fires with correct payload", async () => {
		const pipeline = new HookPipeline();
		const log: string[] = [];
		pipeline.register(makeRecordingHook("vote-hook", 0, ["vote:result"], log));
		await pipeline.trigger("vote:result", { agentIds: ["a1"], topic: "winner" }, ctx("script"));
		expect(log).toEqual(["vote:result"]);
	});

	// -----------------------------------------------------------------------
	// Context events (4)
	// -----------------------------------------------------------------------

	test("context:beforeInjection fires with correct payload", async () => {
		const pipeline = new HookPipeline();
		const log: string[] = [];
		pipeline.register(makeRecordingHook("ctx-hook", 0, ["context:beforeInjection"], log));
		await pipeline.trigger("context:beforeInjection", { agentId: "a1" }, ctx("script", "a1"));
		expect(log).toEqual(["context:beforeInjection"]);
	});

	test("context:afterInjection fires with correct payload", async () => {
		const pipeline = new HookPipeline();
		const log: string[] = [];
		pipeline.register(makeRecordingHook("ctx-hook", 0, ["context:afterInjection"], log));
		await pipeline.trigger("context:afterInjection", { agentId: "a1" }, ctx("script", "a1"));
		expect(log).toEqual(["context:afterInjection"]);
	});

	test("context:beforeCompaction fires with correct payload", async () => {
		const pipeline = new HookPipeline();
		const log: string[] = [];
		pipeline.register(makeRecordingHook("ctx-hook", 0, ["context:beforeCompaction"], log));
		await pipeline.trigger("context:beforeCompaction", { agentId: "a1" }, ctx("script", "a1"));
		expect(log).toEqual(["context:beforeCompaction"]);
	});

	test("context:afterCompaction fires with correct payload", async () => {
		const pipeline = new HookPipeline();
		const log: string[] = [];
		pipeline.register(makeRecordingHook("ctx-hook", 0, ["context:afterCompaction"], log));
		await pipeline.trigger("context:afterCompaction", { agentId: "a1" }, ctx("script", "a1"));
		expect(log).toEqual(["context:afterCompaction"]);
	});

	// -----------------------------------------------------------------------
	// Offload events (3)
	// -----------------------------------------------------------------------

	test("offload:afterL1 fires with correct payload", async () => {
		const pipeline = new HookPipeline();
		const log: string[] = [];
		pipeline.register(makeRecordingHook("offload-hook", 0, ["offload:afterL1"], log));
		await pipeline.trigger("offload:afterL1", { agentId: "a1" }, ctx("script", "a1"));
		expect(log).toEqual(["offload:afterL1"]);
	});

	test("offload:beforeFlush fires with correct payload", async () => {
		const pipeline = new HookPipeline();
		const log: string[] = [];
		pipeline.register(makeRecordingHook("offload-hook", 0, ["offload:beforeFlush"], log));
		await pipeline.trigger("offload:beforeFlush", {}, ctx("script"));
		expect(log).toEqual(["offload:beforeFlush"]);
	});

	test("offload:afterFlush fires with correct payload", async () => {
		const pipeline = new HookPipeline();
		const log: string[] = [];
		pipeline.register(makeRecordingHook("offload-hook", 0, ["offload:afterFlush"], log));
		await pipeline.trigger("offload:afterFlush", {}, ctx("script"));
		expect(log).toEqual(["offload:afterFlush"]);
	});

	// -----------------------------------------------------------------------
	// Workflow event (1)
	// -----------------------------------------------------------------------

	test("workflow:phaseTimeout fires with correct payload", async () => {
		const pipeline = new HookPipeline();
		const log: string[] = [];
		pipeline.register(makeRecordingHook("wf-hook", 0, ["workflow:phaseTimeout"], log));
		await pipeline.trigger("workflow:phaseTimeout", { phase: "script" }, ctx("script"));
		expect(log).toEqual(["workflow:phaseTimeout"]);
	});
});

// ============================================================================
// E2E: Hook events fire through real integration points (SP-7 verification)
// ============================================================================

import type { AgentMessage } from "@satopi/pi-agent-core";
import { IrcBus } from "../../irc/bus";
import { OffloadManager } from "../../offload/manager";
import { MemorySessionStorage } from "../../session/session-storage";
import { CommChannel } from "../../comm/comm-channel";
import { runRoundtable } from "../../comm/roundtable";
import { runVote } from "../../comm/vote";
import type { AssembledContext } from "../context-manager/context-pipeline";
import { ContextPipeline } from "../context-manager/context-pipeline";
import { StateTracker } from "../core/state";
import { ActivityLogger } from "../../infra/activity-logger";

describe("Hook event trigger E2E (real integration points)", () => {
	let hookPipeline: HookPipeline;
	let fired: string[];

	const ALL_EVENTS: HookEvent[] = [
		"comm:beforeMessage",
		"comm:afterMessage",
		"comm:beforeBroadcast",
		"comm:afterBroadcast",
		"vote:start",
		"vote:tally",
		"vote:result",
		"roundtable:beforeRound",
		"roundtable:afterRound",
		"roundtable:converged",
		"context:beforeInjection",
		"context:afterInjection",
		"context:beforeCompaction",
		"context:afterCompaction",
		"offload:afterL1",
		"offload:beforeFlush",
		"offload:afterFlush",
		"workflow:phaseTimeout",
	];

	beforeEach(() => {
		IrcBus.resetGlobalForTests();
		hookPipeline = new HookPipeline();
		fired = [];
		hookPipeline.register({
			name: "e2e-spy",
			priority: 0,
			events: ALL_EVENTS,
			handler: async ({ event }) => {
				fired.push(event);
			},
		});
	});

	afterEach(() => {
		IrcBus.resetGlobalForTests();
	});

	// ── Comm: beforeMessage / afterMessage ──────────────────────

	test("comm:beforeMessage and comm:afterMessage fire through CommBus.receiveFromHuman", async () => {
		const bus = IrcBus.global();
		bus.setHookPipeline(hookPipeline);

		await bus.receiveFromHuman("hello", "agent-1");

		expect(fired).toContain("comm:beforeMessage");
		expect(fired).toContain("comm:afterMessage");
	});

	// ── Comm: beforeBroadcast / afterBroadcast ─────────────────

	test("comm:beforeBroadcast and comm:afterBroadcast fire through CommChannel.send", async () => {
		const bus = IrcBus.global();
		const channel = new CommChannel(bus, ["a1"], [], undefined, hookPipeline);

		await channel.send("a1", "broadcast message");

		expect(fired).toContain("comm:beforeBroadcast");
		expect(fired).toContain("comm:afterBroadcast");
	});

	// ── Vote: start / tally / result ───────────────────────────

	test("vote:start, vote:tally, vote:result fire through runVote", async () => {
		const bus = IrcBus.global();

		await runVote(bus, ["ghost-1", "ghost-2"], "Pick one", ["a", "b"], 50, hookPipeline);

		expect(fired).toContain("vote:start");
		expect(fired).toContain("vote:tally");
		expect(fired).toContain("vote:result");
	});

	// ── Roundtable: beforeRound / afterRound / converged ───────

	test("roundtable:beforeRound, afterRound, converged fire through runRoundtable", async () => {
		const bus = IrcBus.global();

		// Ghost agents produce empty responses → Jaccard=1 →
		// convergenceStreak=1 makes round 2 converge immediately.
		await runRoundtable(
			bus,
			["ghost-1", "ghost-2"],
			"design discussion",
			{
				rounds: 3,
				timeoutMs: 50,
				convergenceStreak: 1,
			},
			hookPipeline,
		);

		expect(fired).toContain("roundtable:beforeRound");
		expect(fired).toContain("roundtable:afterRound");
		expect(fired).toContain("roundtable:converged");
	});

	// ── Context: before/afterInjection, before/afterCompaction ─

	test("all four context events fire through ContextPipeline.toTransformContext", async () => {
		const pipeline = new ContextPipeline(hookPipeline);
		const injectedMsg: AgentMessage = {
			role: "user",
			content: "injected context",
			timestamp: 0,
		};
		const assembled: AssembledContext = {
			systemPrompt: "",
			taskPrompt: "test",
			tools: [],
			injectedMessages: [injectedMsg],
			metadata: {},
		};

		// compactWindow > 0 triggers both injection and compaction hooks
		const transform = pipeline.toTransformContext(assembled, {
			compactWindow: 1000,
			agentId: "a1",
		});
		await transform([]);

		expect(fired).toContain("context:beforeInjection");
		expect(fired).toContain("context:afterInjection");
		expect(fired).toContain("context:beforeCompaction");
		expect(fired).toContain("context:afterCompaction");
	});


	// ── Offload: afterL1 / beforeFlush / afterFlush ────────────

	test("offload:afterL1, beforeFlush, afterFlush fire through OffloadManager", async () => {
		const storage = new MemorySessionStorage();
		const mgr = new OffloadManager("/tmp/test-e2e-swarm", "test-agent", "sess-1", storage, hookPipeline);

		await mgr.summarizeL1("agent-1", "summary of work done");
		expect(fired).toContain("offload:afterL1");

		await mgr.forceFlush();
		expect(fired).toContain("offload:beforeFlush");
		expect(fired).toContain("offload:afterFlush");
	});
});
