/**
 * Tests for nomination protocol, round summary extraction, and reviewer prompt.
 */
import { describe, expect, it } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { WorkerChannel } from "../worker-channel";

// ---------------------------------------------------------------------------
// extractRoundSummary + parseNomination are not exported — test via behavior
// of the WorkerChannel and the inline helpers.
// ---------------------------------------------------------------------------

describe("WorkerChannel nomination protocol", () => {

	function createChannel(workerCount: number): WorkerChannel {
		const bus = new IrcBus({});
		const workers = Array.from({ length: workerCount }, (_, i) => `worker-${i + 1}`);
		return new WorkerChannel(bus, { workers, cloners: [] });
	}

	it("startNomination clears previous state", () => {
		const ch = createChannel(3);
		ch.startNomination(1);
		ch.processNomination("worker-1", "worker-2");
		ch.processNomination("worker-2", "worker-3");

		// Start a new round — nominations should be cleared
		ch.startNomination(2);
		const result = ch.tally();
		expect(result.elected).toBeNull();
		expect(result.round).toBe(2);
	});

	it("tally elects worker with most votes", () => {
		const ch = createChannel(5);
		ch.startNomination(1);
		ch.processNomination("worker-1", "worker-3");
		ch.processNomination("worker-2", "worker-3");
		ch.processNomination("worker-4", "worker-3");
		ch.processNomination("worker-3", "worker-1");
		ch.processNomination("worker-5", "worker-1");

		const result = ch.tally();
		expect(result.elected).toBe("worker-3");
		expect(result.votes["worker-3"]).toHaveLength(3);
		expect(result.votes["worker-1"]).toHaveLength(2);
		expect(result.round).toBe(1);
	});

	it("tally returns null when no nominations cast", () => {
		const ch = createChannel(3);
		ch.startNomination(0);
		const result = ch.tally();
		expect(result.elected).toBeNull();
		expect(Object.keys(result.votes)).toHaveLength(0);
	});

	it("tally breaks ties by first to reach highest count", () => {
		const ch = createChannel(4);
		ch.startNomination(1);
		// worker-2 gets 2 votes first
		ch.processNomination("worker-1", "worker-2");
		ch.processNomination("worker-3", "worker-4");
		ch.processNomination("worker-4", "worker-2");
		ch.processNomination("worker-2", "worker-4");

		const result = ch.tally();
		// Both have 2 votes; first registered (worker-2 from line 1) wins
		expect(result.elected).toBe("worker-2");
	});

	it("processNomination ignores self-nomination", () => {
		const ch = createChannel(3);
		ch.startNomination(1);
		ch.processNomination("worker-1", "worker-1");
		ch.processNomination("worker-2", "worker-1");

		const result = ch.tally();
		expect(result.elected).toBe("worker-1");
		expect(result.votes["worker-1"]).toHaveLength(1); // only worker-2's vote
	});

	it("processNomination ignores non-workers", () => {
		const ch = createChannel(3);
		ch.startNomination(1);
		ch.processNomination("ghost", "worker-2");
		ch.processNomination("worker-1", "nobody");
		ch.processNomination("worker-2", "worker-1");

		const result = ch.tally();
		expect(result.elected).toBe("worker-1");
		expect(result.votes["worker-1"]).toHaveLength(1);
	});

	it("buildNominationPrompt contains round number and worker list", () => {
		const ch = createChannel(3);
		ch.startNomination(2);
		const prompt = ch.buildNominationPrompt();
		expect(prompt).toContain("Round 2");
		expect(prompt).toContain("worker-1");
		expect(prompt).toContain("worker-3");
		expect(prompt).toContain("## Nomination");
		expect(prompt).toContain("nominated:");
	});

	it("buildReviewerPrompt is a non-empty static string", () => {
		const prompt = WorkerChannel.buildReviewerPrompt();
		expect(prompt.length).toBeGreaterThan(100);
		expect(prompt).toContain("REVIEWER ROLE");
		expect(prompt).toContain("Round Summary");
		expect(prompt).toContain("convergence_opinion");
		expect(prompt).toContain("recommended_division");
	});
});

// ---------------------------------------------------------------------------
// extractRoundSummary behavior (tested indirectly through regex pattern)
// ---------------------------------------------------------------------------

describe("extractRoundSummary", () => {
	// Replicate the regex from loop-controller.ts for testability
	const RE = /## Round Summary\n([\s\S]*?)(?=\n## |\n```|\n---\n|---|\n\*\*\*|\n___|$)/;

	function extract(output: string): string {
		const match = output.match(RE);
		return match?.[1]?.trim() || output.slice(0, 2000);
	}

	it("extracts summary section from worker output", () => {
		const output = [
			"Here is my implementation of the auth module.",
			"```typescript",
			"export function login() {}",
			"```",
			"## Round Summary",
			"- Created src/auth/login.ts",
			"- Added JWT support",
			"- Incomplete: refresh tokens",
			"",
			"## Next Steps",
			"Integration tests needed.",
		].join("\n");

		const summary = extract(output);
		expect(summary).toContain("Created src/auth/login.ts");
		expect(summary).toContain("Incomplete: refresh tokens");
		expect(summary).not.toContain("Next Steps"); // stopped at ##
		expect(summary).not.toContain("Integration tests");
	});

	it("falls back to first 2000 chars when no summary section", () => {
		const output = "A".repeat(5000);
		const result = extract(output);
		expect(result).toBe(output.slice(0, 2000));
	});

	it("handles empty output gracefully", () => {
		const result = extract("");
		expect(result).toBe("");
	});

	it("stops at code fence after summary", () => {
		const output = [
			"## Round Summary",
			"- Did some work",
			"```json",
			'{"key": "value"}',
			"```",
		].join("\n");
		const summary = extract(output);
		expect(summary).toContain("- Did some work");
		expect(summary).not.toContain("```json");
		expect(summary).not.toContain('"key"');
	});

	it("stops at horizontal rule after summary", () => {
		const output = [
			"## Round Summary",
			"- Task A done",
			"---",
			"Extra content below rule",
		].join("\n");
		const summary = extract(output);
		expect(summary).toContain("- Task A done");
		expect(summary).not.toContain("Extra content");
	});
});

// ---------------------------------------------------------------------------
// parseNomination behavior (tested indirectly through regex pattern)
// ---------------------------------------------------------------------------

describe("parseNomination", () => {
	const RE = /## Nomination\n([\s\S]*?)(?=\n## |\n```|\n---\n|---|\n\*\*\*|\n___|$)/;

	function parse(output: string): { nominee: string } | null {
		const section = output.match(RE);
		if (!section?.[1]) return null;
		const nominated = section[1].match(/nominated:\s*(\S+)/);
		if (!nominated?.[1]) return null;
		return { nominee: nominated[1] };
	}

	it("parses valid nomination", () => {
		const output = [
			"I did some work.",
			"## Nomination",
			"nominated: worker-3",
			"reason: has the most relevant expertise",
		].join("\n");

		const result = parse(output);
		expect(result).not.toBeNull();
		expect(result!.nominee).toBe("worker-3");
	});

	it("returns null when no nomination section", () => {
		const output = "Just some regular output.";
		expect(parse(output)).toBeNull();
	});

	it("returns null when nomination section has no nominated field", () => {
		const output = [
			"## Nomination",
			"reason: someone should be reviewer",
		].join("\n");
		expect(parse(output)).toBeNull();
	});

	it("handles nomination with extra whitespace around nominated", () => {
		const output = [
			"## Nomination",
			"nominated:   worker-5  ",
			"reason: good at reviews",
		].join("\n");
		const result = parse(output);
		expect(result).not.toBeNull();
		expect(result!.nominee).toBe("worker-5");
	});

	it("stops nomination section at next heading", () => {
		const output = [
			"## Nomination",
			"nominated: worker-2",
			"reason: experienced",
			"## Round Summary",
			"- Did work",
		].join("\n");
		const result = parse(output);
		expect(result).not.toBeNull();
		expect(result!.nominee).toBe("worker-2");
	});
});
