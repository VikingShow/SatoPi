/**
 * session-store.test.ts — Tests for session life-cycle via switchToSession().
 *
 * session-store now delegates all swarm-store state transitions to
 * swarmStore.switchToSession(name, mode).  These tests verify that the
 * delegations happen with correct arguments.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Track switchToSession calls
let switchToSessionCalls: Array<{ name: string; mode: string }> = [];

// Mock swarm-store — expose switchToSession alongside existing fields
vi.mock("../swarm-store", () => ({
  useSwarmStore: {
    getState: () => mockSwarmState as any,
    setState: (partial: Record<string, unknown>) => {
      Object.assign(mockSwarmState, partial);
    },
  },
}));

// Mock api client
vi.mock("../../lib/api-client", () => ({
  api: {
    getRuns: vi.fn().mockResolvedValue({ runs: [] }),
    cancelBeforeLoop: vi.fn().mockResolvedValue({ success: true }),
    stopRun: vi.fn().mockResolvedValue({ success: true }),
    createSession: vi.fn().mockResolvedValue({ success: true }),
  },
  setActiveSession: vi.fn(),
}));

// Mock SSE client
vi.mock("../../lib/sse-client", () => ({
  setActiveSSESession: vi.fn(),
}));

import { useSessionStore } from "../session-store";

let mockSwarmState: Record<string, unknown> = {};

beforeEach(() => {
  useSessionStore.setState({
    activeSwarm: "test-session",
    viewingSession: null,
    runs: [],
  });

  switchToSessionCalls = [];

  mockSwarmState = {
    swarmState: { name: "test-session", status: "idle" },
    activities: [],
    channels: new Map(),
    messages: new Map(),
    activeChannelId: "roundtable",
    loopPhase: "idle" as const,
    beforeLoopState: null,
    planVersion: 0,
    todos: [],
    afterLoopResult: null,
    blockerContext: null,
    error: null,
    init: vi.fn(),
    refreshState: vi.fn().mockResolvedValue(undefined),
    addActivity: vi.fn(),
    switchToSession: vi.fn().mockImplementation((name: string, mode: string) => {
      switchToSessionCalls.push({ name, mode });
      return Promise.resolve();
    }),
  };
});

describe("SessionStore: newSession", () => {
  it("calls swarmStore.switchToSession with generated name and 'live' mode", async () => {
    const result = await useSessionStore.getState().newSession();
    expect(switchToSessionCalls.length).toBe(1);
    expect(switchToSessionCalls[0].mode).toBe("live");
    expect(switchToSessionCalls[0].name).toBe(result);
    expect(result).toMatch(/^SatoPi-/);
  });

  it("updates activeSwarm to the generated name", async () => {
    const result = await useSessionStore.getState().newSession();
    expect(useSessionStore.getState().activeSwarm).toBe(result);
  });

  it("clears viewingSession", async () => {
    useSessionStore.setState({ viewingSession: "old-session" });
    await useSessionStore.getState().newSession();
    expect(useSessionStore.getState().viewingSession).toBeNull();
  });
});

describe("SessionStore: backToCurrent", () => {
  it("clears viewingSession and calls switchToSession('live')", () => {
    useSessionStore.setState({ viewingSession: "old-session" });
    useSessionStore.getState().backToCurrent();
    expect(useSessionStore.getState().viewingSession).toBeNull();
    expect(switchToSessionCalls.length).toBe(1);
    expect(switchToSessionCalls[0].mode).toBe("live");
    expect(switchToSessionCalls[0].name).toBe("test-session");
  });
});
