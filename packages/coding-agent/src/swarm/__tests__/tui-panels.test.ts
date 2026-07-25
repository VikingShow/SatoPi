/**
 * Unit tests for SatoPi TUI panels.
 *
 * Tests:
 *   - renderAgentPanel: all statuses, reviewer tag, empty/null/undefined, maxWidth
 *   - renderCommPanel: timestamp formatting, sender color coding, truncation, empty
 *   - renderContextPanel: sources, offload pipeline, token windows, empty, maxWidth
 */
import { describe, expect, it } from "bun:test";
import { renderAgentPanel } from "../tui/agent-panel";
import { renderCommPanel, type CommMessage } from "../tui/comm-panel";
import { renderContextPanel, type ContextPanelState } from "../tui/context-panel";
import type { SwarmState, AgentState } from "../core/state";

// ============================================================================
// ANSI stripping (local, not exported by theme)
// ============================================================================

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

// ============================================================================
// Helpers
// ============================================================================

/** Assert no visible line exceeds maxWidth. */
function assertMaxWidth(lines: string[], maxWidth: number): void {
  for (let i = 0; i < lines.length; i++) {
    const visible = stripAnsi(lines[i]);
    expect(
      visible.length,
      `Line ${i} exceeds maxWidth ${maxWidth} (actual ${visible.length}): "${visible}"`
    ).toBeLessThanOrEqual(maxWidth);
  }
}

/** Create a minimal SwarmState for testing. */
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

/** Create a minimal AgentState for testing. */
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

/** Create a CommMessage for testing. */
function makeMsg(overrides: Partial<CommMessage> = {}): CommMessage {
  return {
    timestamp: Date.now(),
    from: "human",
    to: "planner",
    body: "test message",
    ...overrides,
  };
}

// ============================================================================
// renderAgentPanel
// ============================================================================

describe("renderAgentPanel", () => {
  const W = 72;

  it("shows 'No agents' when agents object is empty", () => {
    const state = makeSwarmState({ agents: {} });
    const lines = renderAgentPanel(state, W);
    const joined = lines.join("\n");
    expect(stripAnsi(joined)).toContain("No agents");
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
    const lines = renderAgentPanel(state, W);
    const joined = lines.join("\n");

    // Each agent name should appear
    expect(joined).toContain("agent-1");
    expect(joined).toContain("agent-2");
    expect(joined).toContain("agent-3");
    expect(joined).toContain("agent-4");
    expect(joined).toContain("agent-5");

    // Status text should be present (strip ANSI for matching)
    const visible = stripAnsi(joined);
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
    const lines = renderAgentPanel(state, W);
    const joined = lines.join("\n");
    const visible = stripAnsi(joined);
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
    const lines = renderAgentPanel(state, W);
    const joined = lines.join("\n");
    const visible = stripAnsi(joined);
    expect(visible).toContain("请关注安全问题");
    expect(visible).toContain("review:");
  });

  it("truncates long review verdicts", () => {
    const longVerdict = "A".repeat(100);
    const state = makeSwarmState({
      agents: {
        "agent-1": makeAgent({ name: "agent-1", status: "running", role: "reviewer" }),
      },
      reviewVerdict: longVerdict,
    });
    const lines = renderAgentPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    // Should be truncated (not the full 100 chars)
    expect(visible).toContain("...");
    // The truncated verdict display should be at most 43 chars (40 + "...")
    // and definitely not contain the full 100 chars
    expect(visible).not.toContain(longVerdict);
  });

  it("shows no reviewer tag when no agent has reviewer role", () => {
    const state = makeSwarmState({
      agents: {
        "agent-1": makeAgent({ name: "agent-1", status: "running" }),
        "agent-2": makeAgent({ name: "agent-2", status: "running" }),
      },
    });
    const lines = renderAgentPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).not.toContain("reviewer:");
  });

  it("shows model name as role badge when no explicit role", () => {
    const state = makeSwarmState({
      agents: {
        "agent-1": makeAgent({ name: "agent-1", status: "running", modelName: "claude-sonnet" }),
      },
    });
    const lines = renderAgentPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("claude-sonnet");
  });

  it("shows explicit role as role badge", () => {
    const state = makeSwarmState({
      agents: {
        "agent-1": makeAgent({ name: "agent-1", status: "running", role: "reviewer" }),
      },
    });
    const lines = renderAgentPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("[reviewer]");
  });

  it("handles null state gracefully", () => {
    const lines = renderAgentPanel(null, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("No swarm state");
  });

  it("handles undefined state gracefully", () => {
    const lines = renderAgentPanel(undefined, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("No swarm state");
  });

  it("handles agents with missing optional fields", () => {
    const state = makeSwarmState({
      agents: {
        "minimal": {
          name: "minimal",
          status: "running",
          iteration: 0,
          wave: 0,
          praiseCount: 0,
          criticismCount: 0,
          conflictCount: 0,
          // no startedAt, modelName, role, error, etc.
        },
      },
    });
    const lines = renderAgentPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("minimal");
    expect(visible).toMatch(/running/);
  });

  it("shows duration for completed agents", () => {
    const state = makeSwarmState({
      agents: {
        "agent-1": makeAgent({
          name: "agent-1",
          status: "completed",
          startedAt: 100000,
          completedAt: 232000, // 132 seconds = 2m 12s
        }),
      },
    });
    const lines = renderAgentPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toMatch(/2m\s+12s/);
  });

  it("shows running duration using current time", () => {
    const now = Date.now();
    const state = makeSwarmState({
      agents: {
        "agent-1": makeAgent({
          name: "agent-1",
          status: "running",
          startedAt: now - 65000, // 65 seconds ago = 1m 5s
        }),
      },
    });
    const lines = renderAgentPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    // Should contain at least seconds or minutes
    expect(visible).toMatch(/\d+[ms]/);
  });

  it("panel has proper border structure", () => {
    const state = makeSwarmState({
      agents: {
        "agent-1": makeAgent({ name: "agent-1", status: "running" }),
      },
    });
    const lines = renderAgentPanel(state, W);

    // First line should be top border
    expect(lines[0]).toContain("┌");
    expect(lines[0]).toContain("Agents");
    expect(lines[0]).toContain("┐");

    // Last line should be bottom border
    expect(lines[lines.length - 1]).toContain("└");
    expect(lines[lines.length - 1]).toContain("┘");

    // Middle lines should have vertical bars (box drawing)
    for (let i = 1; i < lines.length - 1; i++) {
      expect(stripAnsi(lines[i])).toMatch(/│$/);
    }
  });
});

// ============================================================================
// renderCommPanel
// ============================================================================

describe("renderCommPanel", () => {
  const W = 72;

  it("shows 'No messages' when message list is empty", () => {
    const lines = renderCommPanel([], W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("No messages");
  });

  it("formats timestamps as HH:MM:SS", () => {
    // 2024-01-15 16:42:01 UTC = 1705336921000
    const ts = new Date("2024-01-15T16:42:01Z").getTime();
    const msgs: CommMessage[] = [makeMsg({ timestamp: ts, from: "human", to: "planner", body: "hello" })];
    const lines = renderCommPanel(msgs, W);
    const visible = stripAnsi(lines.join("\n"));
    // Should contain time in HH:MM:SS format
    expect(visible).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("color-codes 'human' sender as amber (primary, ansi256=214)", () => {
    const msgs: CommMessage[] = [makeMsg({ from: "human", to: "planner", body: "test" })];
    const lines = renderCommPanel(msgs, W);
    const full = lines.join("\n");
    // human sender should have primary amber color (ansi256=214)
    expect(full).toContain("\x1b[38;5;214mhuman\x1b[0m");
  });

  it("color-codes 'planner' sender as blue (info, ansi256=69)", () => {
    const msgs: CommMessage[] = [makeMsg({ from: "planner", to: "human", body: "response" })];
    const lines = renderCommPanel(msgs, W);
    const full = lines.join("\n");
    // planner sender should have info blue color (ansi256=69)
    expect(full).toContain("\x1b[38;5;69mplanner\x1b[0m");
  });

  it("color-codes 'system' sender as dim (muted, ansi256=248)", () => {
    const msgs: CommMessage[] = [makeMsg({ from: "system", to: "all", body: "status update" })];
    const lines = renderCommPanel(msgs, W);
    const full = lines.join("\n");
    // system sender should have muted color (ansi256=248)
    expect(full).toContain("\x1b[38;5;248msystem\x1b[0m");
  });

  it("color-codes agent senders as blue (info, ansi256=69)", () => {
    const msgs: CommMessage[] = [
      makeMsg({ from: "agent-2", to: "all", body: "coordination message" }),
      makeMsg({ from: "worker-3", to: "orchestrator", body: "task done" }),
    ];
    const lines = renderCommPanel(msgs, W);
    const full = lines.join("\n");
    // agent- and worker- should both get info blue (ansi256=69)
    expect(full).toContain("\x1b[38;5;69magent-2\x1b[0m");
    expect(full).toContain("\x1b[38;5;69mworker-3\x1b[0m");
  });

  it("truncates long message bodies", () => {
    const longBody = "A".repeat(200);
    const msgs: CommMessage[] = [makeMsg({ from: "human", to: "planner", body: longBody })];
    const lines = renderCommPanel(msgs, W);
    const visible = stripAnsi(lines.join("\n"));
    // Should be truncated with "..."
    expect(visible).toContain("...");
    // Should not contain the full 200 chars
    expect(visible).not.toContain(longBody);
  });

  it("handles null messages gracefully", () => {
    const lines = renderCommPanel(null, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("No messages");
    expect(visible).toContain("0 messages");
  });

  it("handles undefined messages gracefully", () => {
    const lines = renderCommPanel(undefined, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("No messages");
  });

  it("shows message count in footer", () => {
    const msgs: CommMessage[] = [
      makeMsg({ from: "human", to: "planner", body: "msg 1" }),
      makeMsg({ from: "planner", to: "human", body: "msg 2" }),
      makeMsg({ from: "agent-1", to: "all", body: "msg 3" }),
    ];
    const lines = renderCommPanel(msgs, W);
    const visible = stripAnsi(lines[lines.length - 1]);
    expect(visible).toContain("3 messages");
  });

  it("shows singular 'message' for single entry", () => {
    const msgs: CommMessage[] = [makeMsg()];
    const lines = renderCommPanel(msgs, W);
    const visible = stripAnsi(lines[lines.length - 1]);
    expect(visible).toContain("1 message");
    expect(visible).not.toContain("1 messages");
  });

  it("shows messages in reverse chronological order (newest first)", () => {
    const msgs: CommMessage[] = [
      makeMsg({ timestamp: 1000, from: "human", to: "planner", body: "first" }),
      makeMsg({ timestamp: 2000, from: "planner", to: "human", body: "second" }),
      makeMsg({ timestamp: 3000, from: "human", to: "planner", body: "third" }),
    ];
    const lines = renderCommPanel(msgs, W);
    const visible = stripAnsi(lines.join("\n"));
    const firstIdx = visible.indexOf("third");
    const secondIdx = visible.indexOf("second");
    const thirdIdx = visible.indexOf("first");
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(thirdIdx);
  });

  it("panel has proper border structure", () => {
    const msgs: CommMessage[] = [makeMsg()];
    const lines = renderCommPanel(msgs, W);

    expect(lines[0]).toContain("┌");
    expect(lines[0]).toContain("Communications");
    expect(lines[0]).toContain("┐");

    expect(lines[lines.length - 1]).toContain("└");
    expect(lines[lines.length - 1]).toContain("┘");
  });
});

// ============================================================================
// renderContextPanel
// ============================================================================

describe("renderContextPanel", () => {
  const W = 72;

  function makeContextState(overrides: Partial<ContextPanelState> = {}): ContextPanelState {
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
    const state = makeContextState({
      sources: [
        { name: "RoleSource", active: true },
        { name: "ProfileSource", active: true },
        { name: "ExperienceSource", active: false },
      ],
    });
    const lines = renderContextPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("RoleSource");
    expect(visible).toContain("ProfileSource");
    expect(visible).toContain("ExperienceSource");
  });

  it("shows inactive sources with dot marker", () => {
    const state = makeContextState({
      sources: [
        { name: "StigmergySource", active: false },
      ],
    });
    const lines = renderContextPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("StigmergySource");
    // Inactive should show · (dot)
    expect(visible).toMatch(/·\s+StigmergySource/);
  });

  it("shows placeholder when no sources configured", () => {
    const state = makeContextState({ sources: [] });
    const lines = renderContextPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("No context sources");
  });

  it("shows offload L1 pending count", () => {
    const state = makeContextState({ l1PendingCount: 7 });
    const lines = renderContextPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("L1 Pending");
    expect(visible).toContain("7");
  });

  it("shows offload L2 last flush time", () => {
    const state = makeContextState({ l2LastFlushSeconds: 120 });
    const lines = renderContextPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("L2 Last flush");
    expect(visible).toContain("2m ago");
  });

  it("shows 'just now' for very recent L2 flushes", () => {
    const state = makeContextState({ l2LastFlushSeconds: 2 });
    const lines = renderContextPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("just now");
  });

  it("shows offload L3 node and edge counts", () => {
    const state = makeContextState({ l3Nodes: 12, l3Edges: 8 });
    const lines = renderContextPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("L3 Mermaid");
    expect(visible).toContain("12 nodes");
    expect(visible).toContain("8 edges");
  });

  it("formats token counts with thousands separators", () => {
    const state = makeContextState({
      agents: [
        { agentId: "agent-1", tokensUsed: 8234, tokenBudget: 32768 },
      ],
    });
    const lines = renderContextPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("8,234");
    expect(visible).toContain("32,768");
  });

  it("shows token usage percentage", () => {
    const state = makeContextState({
      agents: [
        { agentId: "agent-1", tokensUsed: 8234, tokenBudget: 32768 },
      ],
    });
    const lines = renderContextPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    // 8234 / 32768 ≈ 25%
    expect(visible).toContain("25%");
  });

  it("color-codes high usage (>80%) as danger red (ansi256=203)", () => {
    const state = makeContextState({
      agents: [
        { agentId: "agent-1", tokensUsed: 30000, tokenBudget: 32768 },
      ],
    });
    const lines = renderContextPanel(state, W);
    const full = lines.join("\n");
    // >80% should use danger color (ansi256=203)
    expect(full).toContain("\x1b[38;5;203m");
  });

  it("color-codes medium usage (50-80%) as warning amber (ansi256=214)", () => {
    const state = makeContextState({
      agents: [
        { agentId: "agent-1", tokensUsed: 20000, tokenBudget: 32768 },
      ],
    });
    const lines = renderContextPanel(state, W);
    const full = lines.join("\n");
    // 50-80% should use warning color (ansi256=214)
    expect(full).toContain("\x1b[38;5;214m");
  });

  it("color-codes low usage (<50%) as success green (ansi256=41)", () => {
    const state = makeContextState({
      agents: [
        { agentId: "agent-1", tokensUsed: 5000, tokenBudget: 32768 },
      ],
    });
    const lines = renderContextPanel(state, W);
    const full = lines.join("\n");
    // <50% should use success color (ansi256=41)
    expect(full).toContain("\x1b[38;5;41m");
  });

  it("handles zero token budget gracefully (no division by zero)", () => {
    const state = makeContextState({
      agents: [
        { agentId: "agent-1", tokensUsed: 100, tokenBudget: 0 },
      ],
    });
    const lines = renderContextPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("agent-1");
    expect(visible).toContain("0%");
  });

  it("shows placeholder when no agent context windows", () => {
    const state = makeContextState({ agents: [] });
    const lines = renderContextPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("No agent context windows");
  });

  it("sorts agents by usage percentage descending", () => {
    const state = makeContextState({
      agents: [
        { agentId: "low", tokensUsed: 1000, tokenBudget: 10000 },
        { agentId: "high", tokensUsed: 9000, tokenBudget: 10000 },
        { agentId: "mid", tokensUsed: 5000, tokenBudget: 10000 },
      ],
    });
    const lines = renderContextPanel(state, W);
    const visible = stripAnsi(lines.join("\n"));
    const highIdx = visible.indexOf("high:");
    const midIdx = visible.indexOf("mid:");
    const lowIdx = visible.indexOf("low:");
    expect(highIdx).toBeLessThan(midIdx);
    expect(midIdx).toBeLessThan(lowIdx);
  });

  it("handles null state gracefully", () => {
    const lines = renderContextPanel(null, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("No context state");
  });

  it("handles undefined state gracefully", () => {
    const lines = renderContextPanel(undefined, W);
    const visible = stripAnsi(lines.join("\n"));
    expect(visible).toContain("No context state");
  });

  it("panel has proper border structure", () => {
    const state = makeContextState({
      sources: [{ name: "TestSource", active: true }],
    });
    const lines = renderContextPanel(state, W);

    expect(lines[0]).toContain("┌");
    expect(lines[0]).toContain("Context & Offload");
    expect(lines[0]).toContain("┐");

    expect(lines[lines.length - 1]).toContain("└");
    expect(lines[lines.length - 1]).toContain("┘");
  });
});

// ============================================================================
// MaxWidth compliance (cross-panel)
// ============================================================================

describe("maxWidth compliance", () => {
  const widths = [40, 60, 80, 100, 120];

  describe("renderAgentPanel", () => {
    for (const w of widths) {
      it(`all lines ≤ ${w} chars`, () => {
        const state: SwarmState = {
          name: "test",
          status: "running",
          mode: "loop",
          iteration: 0,
          targetCount: 3,
          agents: {
            "agent-1": makeAgent({ name: "agent-1", status: "completed", startedAt: 1000, completedAt: 5000, modelName: "claude-sonnet" }),
            "agent-2": makeAgent({ name: "agent-2", status: "running", startedAt: 2000, role: "reviewer" }),
            "agent-3": makeAgent({ name: "agent-3", status: "failed", error: "typecheck error in auth.ts line 42" }),
          },
          startedAt: 1000,
          reviewVerdict: "Please focus on security concerns and code quality",
        };
        const lines = renderAgentPanel(state, w);
        assertMaxWidth(lines, w);
      });
    }

    it("all lines ≤ maxWidth with narrow width", () => {
      const state = makeSwarmState({
        agents: {
          "a1": makeAgent({ name: "a1", status: "running" }),
          "a2": makeAgent({ name: "a2", status: "failed", error: "very long error message that should be truncated" }),
        },
      });
      const lines = renderAgentPanel(state, 40);
      assertMaxWidth(lines, 40);
    });
  });

  describe("renderCommPanel", () => {
    for (const w of widths) {
      it(`all lines ≤ ${w} chars`, () => {
        const msgs: CommMessage[] = [
          makeMsg({ timestamp: 1705336921000, from: "human", to: "planner", body: "need to confirm scope of the authentication module" }),
          makeMsg({ timestamp: 1705336935000, from: "planner", to: "human", body: "scope is web-only, no mobile needed for this iteration" }),
          makeMsg({ timestamp: 1705336950000, from: "agent-2", to: "all", body: "need to coordinate auth.ts changes with frontend team" }),
        ];
        const lines = renderCommPanel(msgs, w);
        assertMaxWidth(lines, w);
      });
    }

    it("all lines ≤ maxWidth with long message bodies", () => {
      const msgs: CommMessage[] = [
        makeMsg({ from: "human", to: "planner", body: "A".repeat(500) }),
      ];
      const lines = renderCommPanel(msgs, 60);
      assertMaxWidth(lines, 60);
    });
  });

  describe("renderContextPanel", () => {
    for (const w of widths) {
      it(`all lines ≤ ${w} chars`, () => {
        const state: ContextPanelState = {
          sources: [
            { name: "RoleSource", active: true },
            { name: "ProfileSource", active: true },
            { name: "ExperienceSource", active: false },
            { name: "StigmergySource", active: true },
            { name: "OffloadSource", active: true },
          ],
          l1PendingCount: 23,
          l2LastFlushSeconds: 300,
          l3Nodes: 45,
          l3Edges: 67,
          agents: [
            { agentId: "agent-1", tokensUsed: 8234, tokenBudget: 32768 },
            { agentId: "agent-2-long-name", tokensUsed: 28765, tokenBudget: 32768 },
            { agentId: "agent-3", tokensUsed: 15000, tokenBudget: 20000 },
          ],
        };
        const lines = renderContextPanel(state, w);
        assertMaxWidth(lines, w);
      });
    }

    it("all lines ≤ maxWidth with narrow width", () => {
      const state: ContextPanelState = {
        sources: [
          { name: "VeryLongSourceNameThatShouldBeTruncated", active: true },
        ],
        l1PendingCount: 999,
        l2LastFlushSeconds: 99999,
        l3Nodes: 999,
        l3Edges: 999,
        agents: [
          { agentId: "very-long-agent-identifier", tokensUsed: 999999, tokenBudget: 9999999 },
        ],
      };
      const lines = renderContextPanel(state, 40);
      assertMaxWidth(lines, 40);
    });
  });
});
