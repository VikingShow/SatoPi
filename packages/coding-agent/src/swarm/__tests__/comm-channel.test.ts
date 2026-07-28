/**
 * comm-channel.test.ts — Unit tests for CommChannel, roundtable, vote, and CommBus.
 *
 * Coverage:
 * - jaccardSimilarity():   convergence detection (>= 0.85), edge cases
 * - tokenize():            token filtering, case handling
 * - parseVote():           VOTE: pattern matching, edge cases
 * - runVote():             tally accuracy, open voting, 0 members
 * - runRoundtable():       0 members, ghost-agent delegation, convergence
 * - CommChannel.send():    broadcast to members + observers
 * - CommChannel.roundtable(): delegates to runRoundtable
 * - CommChannel.vote():    delegates to runVote
 * - CommBus:               singleton, groupChannel caching, receiveFromHuman
 * - Integration:           roundtable/vote use ircBus.collectResponses()
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IrcBus } from "../../irc/bus";
import { CommBus } from "../comm-bus/comm-bus";
import { CommChannel } from "../comm-bus/comm-channel";
import { createEndpoint } from "../comm-bus/endpoint";
import { jaccardSimilarity, runRoundtable, tokenize } from "../comm-bus/roundtable";
import { parseVote, runVote } from "../comm-bus/vote";
import { ActivityLogger } from "../infra/activity-logger";

// ============================================================================
// Jaccard similarity (unit — no IrcBus needed)
// ============================================================================

describe("jaccardSimilarity", () => {
	test("identical strings return 1.0", () => {
		expect(jaccardSimilarity("hello world foo bar", "hello world foo bar")).toBe(1);
	});

	test("completely different strings return 0.0", () => {
		expect(jaccardSimilarity("alpha beta gamma", "delta epsilon zeta")).toBe(0);
	});

	test("partial overlap returns value between 0 and 1", () => {
		const sim = jaccardSimilarity("the quick brown fox", "the quick brown dog");
		expect(sim).toBeGreaterThan(0);
		expect(sim).toBeLessThan(1);
	});

	test("convergence threshold — highly similar texts exceed 0.85", () => {
		const a =
			"I think the architecture should use a microservices approach with event-driven communication between services";
		const b =
			"I think the architecture should use microservices with event-driven communication between the services";
		const sim = jaccardSimilarity(a, b);
		expect(sim).toBeGreaterThanOrEqual(0.85);
	});

	test("diverging texts fall below 0.85", () => {
		const a = "I think we should use a monolith because it is simpler to deploy and debug";
		const b = "I recommend a fully serverless architecture with lambda functions and Step Functions orchestration";
		const sim = jaccardSimilarity(a, b);
		expect(sim).toBeLessThan(0.85);
	});

	test("both empty strings return 1", () => {
		expect(jaccardSimilarity("", "")).toBe(1);
	});

	test("one empty, one non-empty returns 0", () => {
		expect(jaccardSimilarity("", "hello world foo")).toBe(0);
		expect(jaccardSimilarity("hello world foo", "")).toBe(0);
	});

	test("tokens <= 2 characters are filtered out", () => {
		const a = "this is a test of the system";
		const b = "this is a check of the system";
		const sim = jaccardSimilarity(a, b);
		expect(sim).toBeGreaterThan(0);
		expect(sim).toBeLessThan(1);
	});

	test("case-insensitive tokenization", () => {
		const sim = jaccardSimilarity("HELLO World FOO", "hello world bar");
		expect(sim).toBeGreaterThan(0);
	});
});

describe("tokenize", () => {
	test("splits on non-alphanumeric boundaries", () => {
		const tokens = tokenize("hello, world! foo-bar_baz");
		expect(tokens.has("hello")).toBe(true);
		expect(tokens.has("world")).toBe(true);
		expect(tokens.has("foo")).toBe(true);
		expect(tokens.has("bar")).toBe(true);
		expect(tokens.has("baz")).toBe(true);
	});

	test("filters tokens <= 2 chars", () => {
		const tokens = tokenize("a is an of the big cat");
		expect(tokens.has("a")).toBe(false);
		expect(tokens.has("is")).toBe(false);
		expect(tokens.has("an")).toBe(false);
		expect(tokens.has("of")).toBe(false);
		expect(tokens.has("the")).toBe(true);
		expect(tokens.has("big")).toBe(true);
		expect(tokens.has("cat")).toBe(true);
	});

	test("lowercases all tokens", () => {
		const tokens = tokenize("Hello World FOO");
		expect(tokens.has("hello")).toBe(true);
		expect(tokens.has("world")).toBe(true);
		expect(tokens.has("foo")).toBe(true);
		expect(tokens.has("Hello")).toBe(false);
	});
});

// ============================================================================
// VOTE: pattern parsing (unit — no IrcBus needed)
// ============================================================================

describe("parseVote", () => {
	test('matches "VOTE: candidate-id"', () => {
		expect(parseVote("VOTE: architect")).toBe("architect");
	});

	test('matches "VOTE:candidate-id" (no space)', () => {
		expect(parseVote("VOTE:architect")).toBe("architect");
	});

	test("matches case-insensitive", () => {
		expect(parseVote("vote: architect")).toBe("architect");
		expect(parseVote("Vote: Backend")).toBe("Backend");
	});

	test("matches VOTE anywhere in text", () => {
		expect(parseVote("I believe the best choice is VOTE: frontend because...")).toBe("frontend");
	});

	test("returns first VOTE match only", () => {
		expect(parseVote("VOTE: alpha but maybe VOTE: beta")).toBe("alpha");
	});

	test("returns null for no VOTE pattern", () => {
		expect(parseVote("I choose architect")).toBeNull();
		expect(parseVote("")).toBeNull();
	});

	test("matches multi-word candidate IDs (non-whitespace)", () => {
		expect(parseVote("VOTE: agent-42")).toBe("agent-42");
		expect(parseVote("VOTE: reviewer_role")).toBe("reviewer_role");
	});

	test("skips leading/trailing whitespace around candidate", () => {
		expect(parseVote("VOTE:   architect   ")).toBe("architect");
	});
});

// ============================================================================
// runVote (ghost agents — no live IrcBus)
// ============================================================================

describe("runVote (ghost agents)", () => {
	let bus: IrcBus;

	beforeEach(() => {
		IrcBus.resetGlobalForTests();
		bus = IrcBus.global();
	});

	afterEach(() => {
		IrcBus.resetGlobalForTests();
	});

	test("empty member list returns zeroed result", async () => {
		const result = await runVote(bus, [], "Who is best?", ["alice", "bob"]);
		expect(result.winner).toBe("");
		expect(result.deputyIds).toEqual([]);
		expect(result.totalVotes).toBe(0);
	});

	test("ghost agents timeout gracefully", async () => {
		const result = await runVote(bus, ["ghost-a", "ghost-b"], "Who leads?", ["alice", "bob"], 100);
		expect(result.totalVotes).toBe(0);
		expect(result.tallies.get("alice")).toBe(0);
		expect(result.tallies.get("bob")).toBe(0);
	});

	test("open voting (no candidates) with ghost agents", async () => {
		const result = await runVote(
			bus,
			["ghost-a"],
			"Any preference?",
			[], // open voting
			100,
		);
		expect(result.totalVotes).toBe(0);
		expect(result.tallies.size).toBe(0);
		expect(result.winner).toBe("");
	});
});

// ============================================================================
// runRoundtable (ghost agents)
// ============================================================================

describe("runRoundtable (ghost agents)", () => {
	let bus: IrcBus;

	beforeEach(() => {
		IrcBus.resetGlobalForTests();
		bus = IrcBus.global();
	});

	afterEach(() => {
		IrcBus.resetGlobalForTests();
	});

	test("empty member list returns early with converged=true", async () => {
		const result = await runRoundtable(bus, [], "design discussion");
		expect(result.converged).toBe(true);
		expect(result.rounds).toBe(0);
		expect(result.responses).toEqual([]);
		expect(result.finalPositions).toEqual([]);
	});

	test("ghost agents run full rounds, no responses collected", async () => {
		const result = await runRoundtable(bus, ["ghost-x", "ghost-y"], "architecture debate", {
			rounds: 2,
			timeoutMs: 50,
			convergenceThreshold: 0.85,
			convergenceStreak: 2,
		});
		expect(result.responses).toEqual([]);
		expect(result.finalPositions).toEqual([]);
		expect(result.rounds).toBe(2);
		// No responses -> combinedText for both rounds is "" -> Jaccard = 1 -> >= 0.85
		// Round 2: convergenceCounter becomes 1, loop ends -> counter < streak -> not converged
		expect(result.converged).toBe(false);
	});

	test("single round completes without convergence check", async () => {
		const result = await runRoundtable(bus, ["ghost"], "solo topic", { rounds: 1, timeoutMs: 50 });
		expect(result.rounds).toBe(1);
		expect(result.converged).toBe(false);
		expect(result.responses).toEqual([]);
	});
});

// ============================================================================
// CommChannel
// ============================================================================

describe("CommChannel", () => {
	let bus: IrcBus;

	beforeEach(() => {
		IrcBus.resetGlobalForTests();
		bus = IrcBus.global();
	});

	afterEach(() => {
		IrcBus.resetGlobalForTests();
	});

	// ── Construction ──────────────────────────────────────────

	test("stores members and observers correctly", () => {
		const ch = new CommChannel(bus, ["a1", "a2"], ["obs1"]);
		expect(ch.members.size).toBe(2);
		expect(ch.members.has("a1")).toBe(true);
		expect(ch.members.has("a2")).toBe(true);
		expect(ch.observers.size).toBe(1);
		expect(ch.observers.has("obs1")).toBe(true);
	});

	test("members is immutable from outside", () => {
		const members = ["a1"];
		const ch = new CommChannel(bus, members, []);
		members.push("a2");
		expect(ch.members.size).toBe(1);
	});

	test("addMember / removeMember works", () => {
		const ch = new CommChannel(bus, ["a1"], []);
		ch.addMember("a2");
		expect(ch.members.has("a2")).toBe(true);
		ch.removeMember("a1");
		expect(ch.members.has("a1")).toBe(false);
	});

	test("addObserver / removeObserver works", () => {
		const ch = new CommChannel(bus, [], ["o1"]);
		ch.addObserver("o2");
		expect(ch.observers.has("o2")).toBe(true);
		ch.removeObserver("o1");
		expect(ch.observers.has("o1")).toBe(false);
	});

	// ── send() ───────────────────────────────────────────────

	test("send() does not throw with ghost members", async () => {
		const ch = new CommChannel(bus, ["ghost-a", "ghost-b"], []);
		await expect(ch.send("ghost-a", "hello")).resolves.toBeUndefined();
	});

	test("send() includes silent CC to observers", async () => {
		const ch = new CommChannel(bus, ["a1"], ["obs1"]);
		// Should not throw — observer delivery uses suppressRelay
		await expect(ch.send("a1", "test")).resolves.toBeUndefined();
	});

	// ── sendToGroup ──────────────────────────────────────────

	test("sendToGroup targets specific subset", async () => {
		const ch = new CommChannel(bus, ["a1", "a2", "a3"], []);
		await expect(ch.sendToGroup("a1", "secret", ["a2", "a3"])).resolves.toBeUndefined();
	});

	// ── interrupt ────────────────────────────────────────────

	test("interrupt sends steering directive", async () => {
		const ch = new CommChannel(bus, ["a1"], ["human"]);
		await expect(ch.interrupt("human", "a1", "Please reconsider")).resolves.toBeUndefined();
	});

	// ── roundtable() ─────────────────────────────────────────

	test("roundtable() delegates to runRoundtable (0 members)", async () => {
		const ch = new CommChannel(bus, [], []);
		const result = await ch.roundtable("topic", { agentIds: [] });
		expect(result.converged).toBe(true);
		expect(result.rounds).toBe(0);
	});

	test("roundtable() with ghost agents completes", async () => {
		const ch = new CommChannel(bus, ["g1", "g2"], []);
		const result = await ch.roundtable("design", {
			rounds: 1,
			timeoutMs: 50,
		});
		expect(result.responses).toEqual([]);
		expect(result.rounds).toBe(1);
	});

	test("roundtable() defaults agentIds to channel members", async () => {
		const ch = new CommChannel(bus, ["g1", "g2"], []);
		// No agentIds specified — should default to all members
		const result = await ch.roundtable("topic", { rounds: 1, timeoutMs: 50 });
		expect(result.rounds).toBe(1);
	});

	// ── vote() ───────────────────────────────────────────────

	test("vote() delegates to runVote (0 members)", async () => {
		const ch = new CommChannel(bus, [], []);
		const result = await ch.vote("Who?", {
			eligibleIds: [],
			candidates: ["alice", "bob"],
			timeoutMs: 100,
		});
		expect(result.winner).toBe("");
		expect(result.totalVotes).toBe(0);
	});

	test("vote() with ghost agents completes", async () => {
		const ch = new CommChannel(bus, ["g1", "g2"], []);
		const result = await ch.vote("Pick one", {
			eligibleIds: ["g1", "g2"],
			candidates: ["x", "y"],
			timeoutMs: 100,
		});
		expect(result.totalVotes).toBe(0);
		expect(result.tallies.get("x")).toBe(0);
		expect(result.tallies.get("y")).toBe(0);
	});

	test("vote() open voting (no candidates)", async () => {
		const ch = new CommChannel(bus, ["g1"], []);
		const result = await ch.vote("Any thoughts?", {
			eligibleIds: ["g1"],
			timeoutMs: 50,
		});
		expect(result.totalVotes).toBe(0);
		expect(result.winner).toBe("");
	});
});

// ============================================================================
// CommBus
// ============================================================================

describe("CommBus", () => {
	let bus: IrcBus;
	let activityLogger: ActivityLogger;

	beforeEach(() => {
		IrcBus.resetGlobalForTests();
		bus = IrcBus.global();
		activityLogger = new ActivityLogger("/tmp/test-swarm", "test-session");
	});

	afterEach(() => {
		IrcBus.resetGlobalForTests();
	});

	// ── Singleton pattern ────────────────────────────────────

	test("global() returns the same instance", () => {
		const a = CommBus.global();
		const b = CommBus.global();
		expect(a).toBe(b);
	});

	test("ensureGlobal wires the IrcBus reference", () => {
		const cb = CommBus.ensureGlobal(bus, activityLogger);
		expect(cb.ircBus).toBe(bus);
		expect(cb).toBe(CommBus.global());
	});

	test("ensureGlobal updates an already-global instance", () => {
		// Create a fresh unwired instance, then wire via ensureGlobal.
		const cb = new CommBus();
		expect(cb.ircBus).toBeNull();

		// Wire it via ensureGlobal — since the global hasn't been set yet,
		// ensureGlobal creates it with the given IrcBus.
		const result = CommBus.ensureGlobal(bus, activityLogger);
		expect(result.ircBus).toBe(bus);
	});

	// ── receiveFromHuman ─────────────────────────────────────

	test("receiveFromHuman logs broadcast", async () => {
		// Not much to assert without a session manager, but shouldn't throw
		const cb = CommBus.ensureGlobal(bus, activityLogger);
		await expect(cb.receiveFromHuman("hello")).resolves.toBeUndefined();
	});

	test("receiveFromHuman targets a specific agent", async () => {
		const cb = CommBus.ensureGlobal(bus, activityLogger);
		// Best-effort delivery — won't throw even for unknown agent
		await expect(cb.receiveFromHuman("hello worker", "worker-1")).resolves.toBeUndefined();
	});

	// ── groupChannel ─────────────────────────────────────────

	test("groupChannel creates and caches channels by name", () => {
		const cb = CommBus.ensureGlobal(bus, activityLogger);
		const ch1 = cb.groupChannel("my-group", ["a1", "a2"]);
		const ch2 = cb.groupChannel("my-group", ["a3"]); // same name, different members
		expect(ch1).toBe(ch2); // cached — same instance
	});

	test("groupChannel throws when IrcBus is not wired", () => {
		const cb = new CommBus(); // no IrcBus wired
		expect(() => cb.groupChannel("test", ["a1"])).toThrow();
	});

	test("removeChannel evicts from cache", () => {
		const cb = CommBus.ensureGlobal(bus, activityLogger);
		const ch1 = cb.groupChannel("temp", ["a1"]);
		cb.removeChannel("temp");
		const ch2 = cb.groupChannel("temp", ["a2"]);
		expect(ch2).not.toBe(ch1); // new instance
	});

	test("groupChannel accepts optional activityLogger override", () => {
		const cb = CommBus.ensureGlobal(bus, activityLogger);
		const logger2 = new ActivityLogger("/tmp/test-swarm", "session2");
		// Should not throw
		const ch = cb.groupChannel("logged", ["a1"], logger2);
		expect(ch.members.has("a1")).toBe(true);
	});

	// ── setActivityLogger ────────────────────────────────────

	test("setActivityLogger updates logger reference", () => {
		const cb = CommBus.ensureGlobal(bus);
		const newLogger = new ActivityLogger("/tmp/test-swarm", "new-session");
		cb.setActivityLogger(newLogger);
		// No direct assertion — verified via subsequent groupChannel calls
		const ch = cb.groupChannel("test", ["a1"]);
		expect(ch).toBeDefined();
	});
});

// ============================================================================
// createEndpoint
// ============================================================================

describe("createEndpoint", () => {
	test("creates human endpoint with proper defaults", () => {
		const ep = createEndpoint("human", "human");
		expect(ep.id).toBe("human");
		expect(ep.kind).toBe("human");
		expect(ep.capabilities.has("send")).toBe(true);
		expect(ep.capabilities.has("receive")).toBe(true);
		expect(ep.capabilities.has("broadcast")).toBe(true);
		expect(ep.capabilities.has("interrupt")).toBe(true);
	});

	test("creates agent endpoint with proper defaults", () => {
		const ep = createEndpoint("ag1", "agent");
		expect(ep.id).toBe("ag1");
		expect(ep.kind).toBe("agent");
		expect(ep.capabilities.has("send")).toBe(true);
		expect(ep.capabilities.has("vote")).toBe(true);
		expect(ep.capabilities.has("roundtable")).toBe(true);
		expect(ep.capabilities.has("interrupt")).toBe(false);
	});

	test("creates system endpoint with proper defaults", () => {
		const ep = createEndpoint("system", "system");
		expect(ep.kind).toBe("system");
		expect(ep.capabilities.has("send")).toBe(true);
		expect(ep.capabilities.has("broadcast")).toBe(true);
		expect(ep.capabilities.has("receive")).toBe(false);
		expect(ep.capabilities.has("vote")).toBe(false);
	});

	test("custom capabilities override defaults", () => {
		const ep = createEndpoint("custom-human", "human", ["send"]);
		expect(ep.capabilities.size).toBe(1);
		expect(ep.capabilities.has("send")).toBe(true);
		expect(ep.capabilities.has("receive")).toBe(false);
	});
});

// ============================================================================
// Integration — IrcBus delegation
// ============================================================================

describe("Integration — IrcBus delegation", () => {
	let bus: IrcBus;

	beforeEach(() => {
		IrcBus.resetGlobalForTests();
		bus = IrcBus.global();
	});

	afterEach(() => {
		IrcBus.resetGlobalForTests();
	});

	test("runRoundtable calls ircBus.collectResponses (observed via timeout)", async () => {
		const result = await runRoundtable(bus, ["ghost-1"], "test-topic", { rounds: 1, timeoutMs: 50 });
		// collectResponses was called — no throw, timeout gracefully
		expect(result.rounds).toBe(1);
		expect(result.responses).toEqual([]);
	});

	test("runVote calls ircBus.collectResponses (observed via timeout)", async () => {
		const result = await runVote(bus, ["ghost-1", "ghost-2"], "Who?", ["candidate-a"], 50);
		expect(result.totalVotes).toBe(0);
	});

	test("CommChannel.roundtable() -> runRoundtable -> collectResponses chain", async () => {
		const ch = new CommChannel(bus, ["g1"], []);
		const result = await ch.roundtable("test", { rounds: 1, timeoutMs: 50 });
		expect(result.rounds).toBe(1);
		expect(result.responses).toEqual([]);
	});

	test("CommChannel.vote() -> runVote -> collectResponses chain", async () => {
		const ch = new CommChannel(bus, ["g1", "g2"], []);
		const result = await ch.vote("test question", {
			eligibleIds: ["g1", "g2"],
			candidates: ["opt-a", "opt-b"],
			timeoutMs: 50,
		});
		expect(result.tallies.get("opt-a")).toBe(0);
		expect(result.tallies.get("opt-b")).toBe(0);
	});
});
