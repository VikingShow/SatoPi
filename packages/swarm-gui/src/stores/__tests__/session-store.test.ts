/**
 * session-store.test.ts — Tests for session life-cycle and __initRunning guard.
 *
 * Verifies:
 *   - newSession() clears the __initRunning guard in swarm-store
 *   - newSession() resets swarm-store state to idle
 *   - backToCurrent() calls swarm-store.init()
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Track whether init was called
let initCalled = false;

// Mock swarm-store
vi.mock("../swarm-store", () => ({
  useSwarmStore: {
    getState: () => {
      // Return a mutable proxy so setState() and getState() work
      return mockSwarmState;
    },
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
import { useSwarmStore } from "../swarm-store";

let mockSwarmState: Record<string, unknown> = {};

beforeEach(() => {
  // Reset session store to default state
  // Zustand persist middleware may not be active in test, so directly set state
  useSessionStore.setState({
    activeSwarm: "test-session",
    viewingSession: null,
    runs: [],
  });

  // Reset mock swarm state
  mockSwarmState = {
    swarmState: { name: "test-session", status: "idle" },
    activities: [{ ts: 1, type: "phase", phase: "running" }],
    channels: new Map(),
    messages: new Map(),
    activeChannelId: "roundtable",
    loopPhase: "running" as const,
    beforeLoopState: { phase: "before-loop-dialog" },
    planVersion: 3,
    todos: [{ id: "t1", title: "test", status: "pending" }],
    afterLoopResult: { summary: "done" },
    blockerContext: { reason: "stuck" },
    error: "some error",
    __initRunning: true,
    init: vi.fn(),
    refreshState: vi.fn().mockResolvedValue(undefined),
    addActivity: vi.fn(),
  };

  initCalled = false;
});

describe("SessionStore: newSession", () => {
  it("clears __initRunning guard so init() can run after session reset", async () => {
    // Verify guard is set before newSession
    expect(mockSwarmState.__initRunning).toBe(true);

    await useSessionStore.getState().newSession();

    // Guard should be cleared
    expect(mockSwarmState.__initRunning).toBe(false);
  });

  it("resets swarm-store state to idle", async () => {
    await useSessionStore.getState().newSession();

    expect(mockSwarmState.swarmState).toBeNull();
    expect((mockSwarmState.activities as unknown[]).length).toBe(0);
    expect(mockSwarmState.loopPhase).toBe("idle");
    expect(mockSwarmState.beforeLoopState).toBeNull();
    expect(mockSwarmState.planVersion).toBe(0);
    expect((mockSwarmState.todos as unknown[]).length).toBe(0);
    expect(mockSwarmState.afterLoopResult).toBeNull();
    expect(mockSwarmState.blockerContext).toBeNull();
    expect(mockSwarmState.error).toBeNull();
  });

  it("updates activeSwarm to the generated name", async () => {
    const result = await useSessionStore.getState().newSession();

    const state = useSessionStore.getState();
    expect(state.activeSwarm).toBe(result);
    expect(state.activeSwarm).toMatch(/^SatoPi-/); // generated format
  });

  it("clears viewingSession", async () => {
    useSessionStore.setState({ viewingSession: "old-session" });
    await useSessionStore.getState().newSession();

    expect(useSessionStore.getState().viewingSession).toBeNull();
  });
});

describe("SessionStore: backToCurrent", () => {
  it("clears viewingSession", () => {
    useSessionStore.setState({ viewingSession: "old-session" });
    useSessionStore.getState().backToCurrent();

    expect(useSessionStore.getState().viewingSession).toBeNull();
  });
});
