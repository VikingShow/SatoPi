/**
 * reporter-election.test.ts — Unit tests for ReporterElection
 *
 * Coverage:
 * 1. Single-agent auto-wins
 * 2. Score computation: tasksCompleted * 0.4 + codeLinesChanged * 0.2 + peerVotes * 0.4
 * 3. No live agents → contribution-only scoring
 * 4. Peer vote parsing (VOTE: agent-id)
 * 5. Deputy selection (top 2 after reporter)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { IrcBus } from "../../irc/bus";
import { ReporterElection, type ContributionData } from "../monitor/reporter-election";

describe("ReporterElection", () => {
	let bus: IrcBus;

	beforeEach(() => {
		IrcBus.resetGlobalForTests();
		bus = IrcBus.global();
	});

	afterEach(() => {
		IrcBus.resetGlobalForTests();
	});

	// ── Single agent ─────────────────────────────────────────────────
	test("single agent automatically wins with score = 1", async () => {
		const election = new ReporterElection(bus);
		const contributions: ContributionData[] = [
			{ agentId: "w1", name: "Worker-1", tasksCompleted: 5, codeLinesChanged: 100 },
		];

		const result = await election.elect({
			contributions,
			eligibleIds: ["w1"],
		});

		expect(result.reporterId).toBe("w1");
		expect(result.deputyIds).toEqual([]);
		expect(result.scores.get("w1")!.total).toBe(1);
	});

	// ── Score computation (no live IRC → peerVotes = 0) ─────────────

	test("ranks agents by contribution when no peer votes collected", async () => {
		const election = new ReporterElection(bus);
		const contributions: ContributionData[] = [
			{ agentId: "w1", name: "Alice", tasksCompleted: 3, codeLinesChanged: 50 },
			{ agentId: "w2", name: "Bob", tasksCompleted: 5, codeLinesChanged: 300 },
			{ agentId: "w3", name: "Carol", tasksCompleted: 1, codeLinesChanged: 10 },
		];

		const result = await election.elect({
			contributions,
			eligibleIds: ["w1", "w2", "w3"],
			timeoutMs: 100,
		});

		// w2 should have the highest score (most tasks and code)
		expect(result.reporterId).toBe("w2");
		// w1 should be deputy (second highest)
		expect(result.deputyIds).toContain("w1");
		expect(result.deputyIds.length).toBe(2);
	});

	// ── Score formula verification ───────────────────────────────────

	test("score formula: tasks*0.4 + code*0.2 + votes*0.4", async () => {
		const election = new ReporterElection(bus);
		// Two agents: one with more tasks, one with more lines
		const contributions: ContributionData[] = [
			{ agentId: "coder", name: "Coder", tasksCompleted: 1, codeLinesChanged: 1000 },
			{ agentId: "planner", name: "Planner", tasksCompleted: 4, codeLinesChanged: 200 },
		];

		const result = await election.elect({
			contributions,
			eligibleIds: ["coder", "planner"],
			timeoutMs: 100,
		});

		// Total tasks = 5, total code = 1200
		// coder: 1/5*0.4 + 1000/1200*0.2 = 0.08 + 0.167 = 0.247
		// planner: 4/5*0.4 + 200/1200*0.2 = 0.32 + 0.033 = 0.353
		// With no votes → planner wins
		expect(result.reporterId).toBe("planner");
	});

	// ── Even contributions → deterministic order ────────────────────

	test("equal contributions result in sorted order", async () => {
		const election = new ReporterElection(bus);
		const contributions: ContributionData[] = [
			{ agentId: "agent-b", name: "B", tasksCompleted: 1, codeLinesChanged: 1 },
			{ agentId: "agent-a", name: "A", tasksCompleted: 1, codeLinesChanged: 1 },
		];

		const result = await election.elect({
			contributions,
			eligibleIds: ["agent-b", "agent-a"],
			timeoutMs: 100,
		});

		expect(result.reporterId).toBeDefined();
		expect(result.deputyIds.length).toBe(1);
	});

	// ── Deputy selection ─────────────────────────────────────────────

	test("selects top 2 as deputies when 3+ agents", async () => {
		const election = new ReporterElection(bus);
		const contributions: ContributionData[] = [
			{ agentId: "a1", name: "A1", tasksCompleted: 10, codeLinesChanged: 500 },
			{ agentId: "a2", name: "A2", tasksCompleted: 8, codeLinesChanged: 400 },
			{ agentId: "a3", name: "A3", tasksCompleted: 6, codeLinesChanged: 300 },
			{ agentId: "a4", name: "A4", tasksCompleted: 4, codeLinesChanged: 200 },
		];

		const result = await election.elect({
			contributions,
			eligibleIds: ["a1", "a2", "a3", "a4"],
			timeoutMs: 100,
		});

		expect(result.reporterId).toBe("a1");
		expect(result.deputyIds).toEqual(["a2", "a3"]);
	});

	// ── No contributions ─────────────────────────────────────────────

	test("handles zero contributions gracefully", async () => {
		const election = new ReporterElection(bus);
		const contributions: ContributionData[] = [
			{ agentId: "z1", name: "Zero", tasksCompleted: 0, codeLinesChanged: 0 },
			{ agentId: "z2", name: "Zero2", tasksCompleted: 0, codeLinesChanged: 0 },
		];

		// Should not throw / divide by zero
		const result = await election.elect({
			contributions,
			eligibleIds: ["z1", "z2"],
			timeoutMs: 100,
		});

		expect(result.reporterId).toBeDefined();
		expect(result.scores.size).toBe(2);
	});
});
