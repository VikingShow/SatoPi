/**
 * Unit tests for SatoPi TUI panels.
 *
 * Tests:
 *   - renderAgentPanel: all statuses, reviewer tag, empty/null/undefined, maxWidth
 *   - renderCommPanel: timestamp formatting, sender color coding, truncation, empty
 *   - renderContextPanel: sources, offload pipeline, token windows, empty, maxWidth
 */
import { describe, expect, it } from "bun:test";
import { renderAgentPanel } from "../../modes/components/swarm/agent-panel";
import { type CommMessage, renderCommPanel } from "../../modes/components/swarm/comm-panel";
import { type ContextPanelState, renderContextPanel } from "../../modes/components/swarm/context-panel";
import type { AgentState, SwarmState } from "../core/state";

// ============================================================================
// Helpers
// ============================================================================

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

function assertMaxWidth(lines: string[], maxWidth: number): void {
	for (let i = 0; i < lines.length; i++) {
		const visible = stripAnsi(lines[i]);
		expect(visible.length, `Line ${i} exceeds ${maxWidth}: "${visible}"`).toBeLessThanOrEqual(maxWidth);
	}
}

function makeSwarmState(overrides: Partial<SwarmState> = {}): SwarmState {
	return {
		name: "test-swarm",
		status: "running",
		mode: "loop",
		iteration: 0,
		targetCount: 4,
		agents: {},
		startedAt: Date.now(),
		...overrides,
	};
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
	return {
		name: "agent-1",
		status: "pending",
		iteration: 0,
		wave: 0,
		praiseCount: 0,
		criticismCount: 0,
		conflictCount: 0,
		...overrides,
	};
}

function makeMsg(overrides: Partial<CommMessage> = {}): CommMessage {
	return { timestamp: Date.now(), from: "human", to: "planner", body: "test message", ...overrides };
}

// ============================================================================
// renderAgentPanel
// ============================================================================

describe("renderAgentPanel", () => {
	const W = 72;

	it("shows 'No agents' when agents object is empty", () => {
		const state = makeSwarmState({ agents: {} });
		const lines = renderAgentPanel([], state, W);
		expect(stripAnsi(lines.join("\n"))).toContain("No agents");
	});

	it("shows all agent statuses in the output", () => {
		const state = makeSwarmState({
			agents: {
				"agent-1": makeAgent({ name: "agent-1", status: "completed", startedAt: 1000, completedAt: 2000 }),
				"agent-2": makeAgent({ name: "agent-2", status: "running", startedAt: 1500 }),
				"agent-3": makeAgent({ name: "agent-3", status: "waiting" }),
				"agent-4": makeAgent({ name: "agent-4", status: "failed", error: "typecheck error" }),
				"agent-5": makeAgent({ name: "agent-5", status: "pending" }),
			},
		});
		const visible = stripAnsi(renderAgentPanel([], state, W).join("\n"));
		expect(visible).toContain("agent-1");
		expect(visible).toContain("agent-2");
		expect(visible).toContain("agent-3");
		expect(visible).toContain("agent-4");
		expect(visible).toContain("agent-5");
		expect(visible).toMatch(/done/);
		expect(visible).toMatch(/running/);
		expect(visible).toMatch(/waiting/);
		expect(visible).toMatch(/failed/);
	});

	it("shows reviewer tag when an agent has role 'reviewer'", () => {
		const state = makeSwarmState({
			agents: {
				"agent-1": makeAgent({ name: "agent-1", status: "running" }),
				"agent-2": makeAgent({ name: "agent-2", status: "running", role: "reviewer" }),
			},
		});
		const visible = stripAnsi(renderAgentPanel([], state, W).join("\n"));
		expect(visible).toContain("reviewer:");
		expect(visible).toContain("agent-2");
	});

	it("shows review verdict as steering text", () => {
		const state = makeSwarmState({
			agents: {
				"agent-1": makeAgent({ name: "agent-1", status: "running" }),
				"agent-3": makeAgent({ name: "agent-3", status: "running", role: "reviewer" }),
			},
			reviewVerdict: "请关注安全问题",
		});
		const visible = stripAnsi(renderAgentPanel([], state, W).join("\n"));
		expect(visible).toContain("请关注安全问题");
		expect(visible).toContain("review:");
	});

	it("truncates long review verdicts", () => {
		const longVerdict = "A".repeat(100);
		const state = makeSwarmState({
			agents: { "agent-1": makeAgent({ name: "agent-1", status: "running", role: "reviewer" }) },
			reviewVerdict: longVerdict,
		});
		const visible = stripAnsi(renderAgentPanel([], state, W).join("\n"));
		expect(visible).toContain("...");
		expect(visible).not.toContain(longVerdict);
	});

	it("shows model name as role badge when no explicit role", () => {
		const state = makeSwarmState({
			agents: { "agent-1": makeAgent({ name: "agent-1", status: "running", modelName: "claude-sonnet" }) },
		});
		expect(stripAnsi(renderAgentPanel([], state, W).join("\n"))).toContain("claude-sonnet");
	});

	it("shows explicit role as role badge", () => {
		const state = makeSwarmState({
			agents: { "agent-1": makeAgent({ name: "agent-1", status: "running", role: "reviewer" }) },
		});
		expect(stripAnsi(renderAgentPanel([], state, W).join("\n"))).toContain("[reviewer]");
	});

	it("handles null/undefined state gracefully", () => {
		expect(stripAnsi(renderAgentPanel([], null, W).join("\n"))).toContain("No agents");
		expect(stripAnsi(renderAgentPanel([], undefined, W).join("\n"))).toContain("No agents");
	});

	it("handles agents with missing optional fields", () => {
		const state = makeSwarmState({
			agents: {
				minimal: {
					name: "minimal",
					status: "running",
					iteration: 0,
					wave: 0,
					praiseCount: 0,
					criticismCount: 0,
					conflictCount: 0,
				},
			},
		});
		const visible = stripAnsi(renderAgentPanel([], state, W).join("\n"));
		expect(visible).toContain("minimal");
		expect(visible).toMatch(/running/);
	});

	it("shows duration for completed agents", () => {
		const state = makeSwarmState({
			agents: {
				"agent-1": makeAgent({ name: "agent-1", status: "completed", startedAt: 100000, completedAt: 232000 }),
			},
		});
		expect(stripAnsi(renderAgentPanel([], state, W).join("\n"))).toMatch(/2m\s+12s/);
	});

	it("panel has proper border structure", () => {
		const state = makeSwarmState({ agents: { "agent-1": makeAgent({ name: "agent-1", status: "running" }) } });
		const lines = renderAgentPanel([], state, W);
		expect(stripAnsi(lines[0])).toMatch(/^[┌╭].*Agents.*[┐╮]$/);
		expect(stripAnsi(lines[lines.length - 1])).toMatch(/^[└╰].*[┘╯]$/);
	});

	it("status lines show glyphs and status labels", () => {
		const state = makeSwarmState({
			agents: {
				"agent-1": makeAgent({ name: "agent-1", status: "completed", startedAt: 1000, completedAt: 2000 }),
				"agent-2": makeAgent({ name: "agent-2", status: "failed", error: "broken" }),
			},
		});
		const full = renderAgentPanel([], state, W).join("\n");
		// Completed agents show done glyph and label
		expect(full).toContain("agent-1");
		expect(full).toMatch(/✓.*done/);
		// Failed agents show error glyph and error message
		expect(full).toContain("agent-2");
		expect(full).toContain("broken");
	});
});

// ============================================================================
// renderCommPanel
// ============================================================================

describe("renderCommPanel", () => {
	const W = 72;

	it("shows 'No messages' when message list is empty", () => {
		expect(stripAnsi(renderCommPanel([], W).join("\n"))).toContain("No messages");
	});

	it("formats timestamps as HH:MM:SS", () => {
		const ts = new Date("2024-01-15T16:42:01Z").getTime();
		const lines = renderCommPanel([makeMsg({ timestamp: ts, from: "human", to: "planner", body: "hello" })], W);
		expect(stripAnsi(lines.join("\n"))).toMatch(/\d{2}:\d{2}:\d{2}/);
	});

	it("shows sender, arrow, and recipient in messages", () => {
		const msgs: CommMessage[] = [makeMsg({ from: "human", to: "planner", body: "test" })];
		const full = renderCommPanel(msgs, W).join("\n");
		expect(full).toContain("human");
		expect(full).toContain("planner");
		expect(full).toContain("→");
		expect(full).toContain("test");
	});

	it("truncates long message bodies", () => {
		const longBody = "A".repeat(200);
		const lines = renderCommPanel([makeMsg({ from: "human", to: "planner", body: longBody })], W);
		const visible = stripAnsi(lines.join("\n"));
		expect(visible).toContain("…");
		expect(visible).not.toContain(longBody);
	});

	it("handles null/undefined messages gracefully", () => {
		expect(stripAnsi(renderCommPanel(null, W).join("\n"))).toContain("No messages");
		expect(stripAnsi(renderCommPanel(undefined, W).join("\n"))).toContain("No messages");
	});

	it("shows message count in footer", () => {
		const msgs: CommMessage[] = [makeMsg(), makeMsg(), makeMsg()];
		expect(stripAnsi(renderCommPanel(msgs, W).join("\n"))).toContain("3 messages");
	});

	it("shows singular 'message' for single entry", () => {
		const visible = stripAnsi(renderCommPanel([makeMsg()], W).join("\n"));
		expect(visible).toContain("1 message");
		expect(visible).not.toContain("1 messages");
	});

	it("panel has proper border structure", () => {
		const lines = renderCommPanel([makeMsg()], W);
		expect(stripAnsi(lines[0])).toMatch(/^[┌╭].*Comm.*[┐╮]$/);
		expect(stripAnsi(lines[lines.length - 1])).toMatch(/^[└╰].*[┘╯]$/);
	});
});

// ============================================================================
// renderContextPanel
// ============================================================================

describe("renderContextPanel", () => {
	const W = 72;

	function makeCtx(overrides: Partial<ContextPanelState> = {}): ContextPanelState {
		return {
			sources: [],
			l1PendingCount: 0,
			l2LastFlushSeconds: 0,
			l3Nodes: 0,
			l3Edges: 0,
			agents: [],
			...overrides,
		};
	}

	it("shows active sources with checkmark", () => {
		const state = makeCtx({
			sources: [
				{ name: "RoleSource", active: true },
				{ name: "ExperienceSource", active: false },
			],
		});
		const visible = stripAnsi(renderContextPanel(state, W).join("\n"));
		expect(visible).toContain("RoleSource");
		expect(visible).toContain("ExperienceSource");
	});

	it("shows offload L1 pending count", () => {
		const visible = stripAnsi(renderContextPanel(makeCtx({ l1PendingCount: 7 }), W).join("\n"));
		expect(visible).toContain("7 pending");
	});

	it("shows offload L2 last flush time", () => {
		const visible = stripAnsi(renderContextPanel(makeCtx({ l2LastFlushSeconds: 120 }), W).join("\n"));
		expect(visible).toContain("2m ago");
	});

	it("shows 'just now' for very recent L2 flushes", () => {
		const visible = stripAnsi(renderContextPanel(makeCtx({ l2LastFlushSeconds: 2 }), W).join("\n"));
		expect(visible).toContain("just now");
	});

	it("shows offload L3 node and edge counts", () => {
		const visible = stripAnsi(renderContextPanel(makeCtx({ l3Nodes: 12, l3Edges: 8 }), W).join("\n"));
		expect(visible).toContain("12 nodes");
		expect(visible).toContain("8 edges");
	});

	it("formats token counts with thousands separators", () => {
		const state = makeCtx({ agents: [{ agentId: "agent-1", tokensUsed: 8234, tokenBudget: 32768 }] });
		expect(stripAnsi(renderContextPanel(state, W).join("\n"))).toContain("8,234");
	});

	it("shows token usage percentage", () => {
		const state = makeCtx({ agents: [{ agentId: "agent-1", tokensUsed: 8234, tokenBudget: 32768 }] });
		expect(stripAnsi(renderContextPanel(state, W).join("\n"))).toContain("25%");
	});

	it("shows high-usage percentage for near-full windows", () => {
		const state = makeCtx({ agents: [{ agentId: "agent-1", tokensUsed: 30000, tokenBudget: 32768 }] });
		const full = renderContextPanel(state, W).join("\n");
		// 30000/32768 ≈ 92% — high usage, should be visible
		expect(full).toContain("92%");
		expect(full).toContain("30,000");
		expect(full).toContain("32,768");
	});

	it("handles zero token budget gracefully", () => {
		const state = makeCtx({ agents: [{ agentId: "agent-1", tokensUsed: 100, tokenBudget: 0 }] });
		const visible = stripAnsi(renderContextPanel(state, W).join("\n"));
		expect(visible).toContain("agent-1");
		expect(visible).toContain("0%");
	});

	it("handles null/undefined state gracefully", () => {
		expect(stripAnsi(renderContextPanel(null, W).join("\n"))).toContain("No context state");
		expect(stripAnsi(renderContextPanel(undefined, W).join("\n"))).toContain("No context state");
	});

	it("panel has proper border structure", () => {
		const state = makeCtx({ sources: [{ name: "TestSource", active: true }] });
		const lines = renderContextPanel(state, W);
		expect(stripAnsi(lines[0])).toMatch(/^[┌╭].*Context.*[┐╮]$/);
		expect(stripAnsi(lines[lines.length - 1])).toMatch(/^[└╰].*[┘╯]$/);
	});
});

// ============================================================================
// maxWidth compliance
// ============================================================================

describe("maxWidth compliance", () => {
	const widths = [40, 60, 80, 100, 120];

	describe("renderAgentPanel", () => {
		for (const w of widths) {
			it(`all lines ≤ ${w} chars`, () => {
				const state = makeSwarmState({
					agents: {
						"agent-1": makeAgent({
							name: "agent-1",
							status: "completed",
							startedAt: 1000,
							completedAt: 5000,
							modelName: "claude-sonnet",
						}),
						"agent-2": makeAgent({ name: "agent-2", status: "running", startedAt: 2000, role: "reviewer" }),
						"agent-3": makeAgent({ name: "agent-3", status: "failed", error: "typecheck error in auth.ts" }),
					},
					startedAt: 1000,
					reviewVerdict: "Please focus on security",
				});
				assertMaxWidth(renderAgentPanel([], state, w), w);
			});
		}
	});

	describe("renderCommPanel", () => {
		for (const w of widths) {
			it(`all lines ≤ ${w} chars`, () => {
				const msgs: CommMessage[] = [
					makeMsg({ timestamp: 1705336921000, from: "human", to: "planner", body: "need to confirm scope" }),
					makeMsg({ timestamp: 1705336935000, from: "planner", to: "human", body: "scope is web-only" }),
				];
				assertMaxWidth(renderCommPanel(msgs, w), w);
			});
		}
	});

	describe("renderContextPanel", () => {
		for (const w of widths) {
			it(`all lines ≤ ${w} chars`, () => {
				const state: ContextPanelState = {
					sources: [
						{ name: "RoleSource", active: true },
						{ name: "ExperienceSource", active: false },
					],
					l1PendingCount: 23,
					l2LastFlushSeconds: 300,
					l3Nodes: 45,
					l3Edges: 67,
					agents: [{ agentId: "agent-1", tokensUsed: 8234, tokenBudget: 32768 }],
				};
				assertMaxWidth(renderContextPanel(state, w), w);
			});
		}
	});
});
