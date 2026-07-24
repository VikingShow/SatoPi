/**
 * agent-offload-summarizer.test.ts — Unit tests for AgentOffloadSummarizer
 *
 * Coverage:
 * 1. Extracts last assistant message text content
 * 2. Handles array content blocks
 * 3. Falls back to last user message when no assistant
 * 4. Truncates >200 char summaries with ellipsis
 * 5. [no output] + score=0 when messages are empty
 * 6. Uses external score when provided, default 5 otherwise
 * 7. Generates resultRef for large outputs (>2000 chars)
 * 8. Uses taskDescription > phaseHint > default for taskCall
 * 9. Sets timestamp to ISO string
 */

import { describe, test, expect } from "bun:test";
import {
	AgentOffloadSummarizer,
	type AgentOffloadSummarizeInput,
} from "../offload/agent-offload-summarizer";

describe("AgentOffloadSummarizer", () => {
	const summarizer = new AgentOffloadSummarizer();

	function makeMsg(role: "user" | "assistant", content: string | Array<{ type: string; text: string }>) {
		return { role, content } as any;
	}

	// ── Basic extraction ────────────────────────────────────────────

	test("extracts text from last assistant message", () => {
		const input: AgentOffloadSummarizeInput = {
			messages: [
				makeMsg("user", "What is 2+2?"),
				makeMsg("assistant", "The answer is 4."),
			],
			agentId: "agent-1",
			turnIndex: 0,
		};

		const entry = summarizer.summarize(input);
		expect(entry.agentId).toBe("agent-1");
		expect(entry.summary).toBe("The answer is 4.");
		expect(entry.turnIndex).toBe(0);
	});

	test("uses only the LAST assistant message (skips earlier ones)", () => {
		const input: AgentOffloadSummarizeInput = {
			messages: [
				makeMsg("assistant", "First response"),
				makeMsg("user", "Try again"),
				makeMsg("assistant", "Second response"),
			],
			agentId: "agent-2",
			turnIndex: 1,
		};

		const entry = summarizer.summarize(input);
		expect(entry.summary).toBe("Second response");
	});

	// ── Array content blocks ─────────────────────────────────────────

	test("handles array content blocks (multiple text parts)", () => {
		const input: AgentOffloadSummarizeInput = {
			messages: [
				makeMsg("assistant", [
					{ type: "text", text: "Part one. " },
					{ type: "text", text: "Part two." },
				]),
			],
			agentId: "agent-3",
			turnIndex: 0,
		};

		const entry = summarizer.summarize(input);
		// The summarizer joins array text parts with newlines
		expect(entry.summary).toContain("Part one");
		expect(entry.summary).toContain("Part two");
	});

	test("filters out non-text blocks from array content", () => {
		const input: AgentOffloadSummarizeInput = {
			messages: [
				makeMsg("assistant", [
					{ type: "tool_use", tool: "read_file" } as any,
					{ type: "text", text: "I read the file." },
					{ type: "tool_result", result: "ok" } as any,
				]),
			],
			agentId: "agent-4",
			turnIndex: 0,
		};

		const entry = summarizer.summarize(input);
		expect(entry.summary).toBe("I read the file.");
	});

	// ── Fallback to user message ─────────────────────────────────────

	test("falls back to last user message when no assistant response", () => {
		const input: AgentOffloadSummarizeInput = {
			messages: [
				makeMsg("user", "Please write a function."),
			],
			agentId: "agent-5",
			turnIndex: 0,
		};

		const entry = summarizer.summarize(input);
		expect(entry.summary).toBe("Please write a function.");
	});

	// ── Truncation ───────────────────────────────────────────────────

	test("truncates summaries longer than 200 characters with ellipsis", () => {
		const longText = "A".repeat(300);
		const input: AgentOffloadSummarizeInput = {
			messages: [makeMsg("assistant", longText)],
			agentId: "agent-6",
			turnIndex: 0,
		};

		const entry = summarizer.summarize(input);
		expect(entry.summary.length).toBe(201); // 200 + "…"
		expect(entry.summary).toEndWith("…");
	});

	test("does NOT truncate messages exactly at 200 chars", () => {
		const exactText = "B".repeat(200);
		const input: AgentOffloadSummarizeInput = {
			messages: [makeMsg("assistant", exactText)],
			agentId: "agent-7",
			turnIndex: 0,
		};

		const entry = summarizer.summarize(input);
		expect(entry.summary).toBe(exactText); // no ellipsis
	});

	// ── Empty output ─────────────────────────────────────────────────

	test("returns [no output] + score=0 when messages are empty", () => {
		const input: AgentOffloadSummarizeInput = {
			messages: [],
			agentId: "agent-8",
			turnIndex: 0,
		};

		const entry = summarizer.summarize(input);
		expect(entry.summary).toBe("[no output]");
		expect(entry.score).toBe(0);
	});

	test("returns [no output] when last assistant has empty string", () => {
		const input: AgentOffloadSummarizeInput = {
			messages: [makeMsg("assistant", "")],
			agentId: "agent-9",
			turnIndex: 0,
		};

		const entry = summarizer.summarize(input);
		expect(entry.summary).toBe("[no output]");
		expect(entry.score).toBe(0);
	});

	// ── Score handling ───────────────────────────────────────────────

	test("uses external score when provided", () => {
		const input: AgentOffloadSummarizeInput = {
			messages: [makeMsg("assistant", "Quality work.")],
			agentId: "agent-10",
			turnIndex: 0,
			score: 9,
		};

		const entry = summarizer.summarize(input);
		expect(entry.score).toBe(9);
	});

	test("defaults score to 5 when not provided and output exists", () => {
		const input: AgentOffloadSummarizeInput = {
			messages: [makeMsg("assistant", "Work done.")],
			agentId: "agent-11",
			turnIndex: 0,
		};

		const entry = summarizer.summarize(input);
		expect(entry.score).toBe(5);
	});

	// ── resultRef for large outputs ──────────────────────────────────

	test("sets resultRef for outputs > 2000 chars", () => {
		const hugeText = "X".repeat(2500);
		const input: AgentOffloadSummarizeInput = {
			messages: [makeMsg("assistant", hugeText)],
			agentId: "agent-12",
			turnIndex: 3,
		};

		const entry = summarizer.summarize(input);
		expect(entry.resultRef).toBe("artifact://offload/agent-12/3");
	});

	test("leaves resultRef undefined for small outputs", () => {
		const input: AgentOffloadSummarizeInput = {
			messages: [makeMsg("assistant", "Short output")],
			agentId: "agent-13",
			turnIndex: 0,
		};

		const entry = summarizer.summarize(input);
		expect(entry.resultRef).toBeUndefined();
	});

	// ── taskCall priority ────────────────────────────────────────────

	test("uses taskDescription as taskCall when provided", () => {
		const input: AgentOffloadSummarizeInput = {
			messages: [makeMsg("assistant", "done")],
			agentId: "agent-14",
			turnIndex: 0,
			taskDescription: "Implement login API",
			phaseHint: "backend",
		};

		const entry = summarizer.summarize(input);
		expect(entry.taskCall).toBe("Implement login API");
	});

	test("falls back to phaseHint when no taskDescription", () => {
		const input: AgentOffloadSummarizeInput = {
			messages: [makeMsg("assistant", "done")],
			agentId: "agent-15",
			turnIndex: 2,
			phaseHint: "frontend",
		};

		const entry = summarizer.summarize(input);
		expect(entry.taskCall).toBe("frontend");
	});

	test("uses default taskCall format when neither taskDescription nor phaseHint", () => {
		const input: AgentOffloadSummarizeInput = {
			messages: [makeMsg("assistant", "done")],
			agentId: "agent-16",
			turnIndex: 5,
		};

		const entry = summarizer.summarize(input);
		expect(entry.taskCall).toBe("Agent turn 5: agent-16");
	});

	// ── Timestamp ───────────────────────────────────────────────────

	test("includes ISO timestamp", () => {
		const before = new Date().toISOString();
		const input: AgentOffloadSummarizeInput = {
			messages: [makeMsg("assistant", "done")],
			agentId: "agent-17",
			turnIndex: 0,
		};

		const entry = summarizer.summarize(input);
		expect(entry.timestamp).toBeString();
		expect(new Date(entry.timestamp).getTime()).toBeGreaterThanOrEqual(
			new Date(before).getTime(),
		);
	});
});
