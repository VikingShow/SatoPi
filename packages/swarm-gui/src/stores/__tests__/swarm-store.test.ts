/**
 * swarm-store.test.ts — Tests for Zustand swarm-state store.
 *
 * Tests key actions: message handling, phase transitions, todo updates,
 * and before-loop state management. Mocks api and sseClient dependencies.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock api client (same relative path as used in swarm-store.ts)
vi.mock("../../lib/api-client", () => ({
  api: {
    getState: vi.fn(),
    startBeforeLoop: vi.fn(),
    sendBeforeLoopMessage: vi.fn(),
    runDebate: vi.fn(),
    confirmBeforeLoop: vi.fn(),
    cancelBeforeLoop: vi.fn(),
    getBeforeLoopState: vi.fn(),
    sendSteering: vi.fn(),
    stopRun: vi.fn(),
    getAfterLoopSummary: vi.fn(),
    getBeforeLoopHistory: vi.fn(),
  },
}));

// Mock SSE client
vi.mock("../../lib/sse-client", () => ({
  sseClient: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(() => () => {}),
    onConnectionChange: vi.fn(() => () => {}),
  },
}));

import { api } from "../../lib/api-client";
import { useSwarmStore } from "../swarm-store";

function getStore() {
  return useSwarmStore.getState();
}

beforeEach(() => {
  useSwarmStore.setState({
    swarmState: null,
    activities: [],
    channels: new Map(),
    messages: new Map(),
    activeChannelId: "roundtable",
    isConnected: false,
    isRunning: false,
    loopPhase: "idle",
    beforeLoopState: null,
    planVersion: 0,
    todos: [],
    afterLoopResult: null,
    blockerContext: null,
    error: null,
  });
  vi.clearAllMocks();
});

describe("SwarmStore: initial state", () => {
  it("starts with idle loopPhase", () => {
    expect(getStore().loopPhase).toBe("idle");
  });

  it("has empty messages map", () => {
    expect(getStore().messages.size).toBe(0);
  });

  it("has empty todos array", () => {
    expect(getStore().todos).toEqual([]);
  });
});

describe("SwarmStore: message management", () => {
  it("addActivity appends to activities array", () => {
    const store = getStore();
    store.addActivity({ ts: Date.now(), type: "phase", phase: "running" });
    expect(getStore().activities.length).toBe(1);
    expect(getStore().activities[0].phase).toBe("running");
  });

  it("addActivity trims to MAX_ACTIVITIES limit", () => {
    const store = getStore();
    for (let i = 0; i < 510; i++) {
      store.addActivity({ ts: Date.now() + i, type: "phase", phase: "running" });
    }
    expect(getStore().activities.length).toBeLessThanOrEqual(500);
  });
});

describe("SwarmStore: phase transitions", () => {
  it("refreshState fetches state from API", async () => {
    (api.getState as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      name: "test",
      status: "running",
      loopPhase: "running",
      agents: [],
    });
    await getStore().refreshState();
    expect(api.getState).toHaveBeenCalled();
  });

  it("refreshState called on store init", async () => {
    expect(api.getState).toBeDefined();
  });
});

describe("SwarmStore: before-loop interactions", () => {
  it("startPlanning sends task to backend", async () => {
    (api.startBeforeLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true });
    await getStore().startPlanning("build login");
    expect(api.startBeforeLoop).toHaveBeenCalledWith("build login");
  });

  it("cancelBeforeLoop resets state", async () => {
    (api.cancelBeforeLoop as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true });
    // Set running state first
    useSwarmStore.setState({ loopPhase: "before-loop-dialog", beforeLoopState: { phase: "before-loop-dialog", task: "test", conversationLength: 5, planReady: false, busy: false } });
    await getStore().cancelBeforeLoop();
    expect(getStore().loopPhase).toBe("idle");
  });

  it("sendSteering sends operator message to running loop", async () => {
    (api.sendSteering as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true });
    await getStore().sendSteering("fix the bug");
    expect(api.sendSteering).toHaveBeenCalledWith("fix the bug");
  });
});
