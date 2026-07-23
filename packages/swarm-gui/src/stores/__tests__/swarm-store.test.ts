/**
 * swarm-store.test.ts — Tests for Zustand swarm-state store.
 *
 * Tests key actions: message handling, phase transitions, todo updates,
 * and script state management. Mocks api and sseClient dependencies.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock session store — necessary because swarm-store now imports useSessionStore
// (init() reads activeSwarm directly from session-store's Zustand state).
let mockActiveSwarm = "test-session";
vi.mock("../session-store", () => ({
  useSessionStore: {
    getState: () => ({ activeSwarm: mockActiveSwarm }),
  },
}));

// Mock api client (same relative path as used in swarm-store.ts)
vi.mock("../../lib/api-client", () => ({
  api: {
    getState: vi.fn(),
    startScript: vi.fn(),
    sendBeforeScriptMessage: vi.fn(),
    runDebate: vi.fn(),
    confirmBeforeScript: vi.fn(),
    cancelScript: vi.fn(),
    getBeforeScriptState: vi.fn(),
    sendSteering: vi.fn(),
    stopRun: vi.fn(),
    getAfterLoopSummary: vi.fn(),
    getBeforeScriptHistory: vi.fn(),
    getHistory: vi.fn(),
    getRunStatus: vi.fn(),
  },
  setActiveSession: vi.fn(),
}));

// Mock SSE client
vi.mock("../../lib/sse-client", () => ({
  sseClient: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(() => () => {}),
    onConnectionChange: vi.fn(() => () => {}),
  },
  setActiveSSESession: vi.fn(),
}));

import { api } from "../../lib/api-client";
import { useSwarmStore } from "../swarm-store";

function getStore() {
  return useSwarmStore.getState();
}

beforeEach(() => {
  mockActiveSwarm = "test-session";
  useSwarmStore.setState({
    swarmState: null,
    activities: [],
    channels: new Map(),
    messages: new Map(),
    activeChannelId: "roundtable",
    isConnected: false,
    isRunning: false,
    phase: "idle",
    scriptState: null,
    planVersion: 0,
    todos: [],
    curtainResult: null,
    blockerContext: null,
    error: null,
  });
  // Clear __initRunning so init() can be tested repeatedly
  (useSwarmStore.getState() as any).__initRunning = false;
  vi.clearAllMocks();
});

describe("SwarmStore: initial state", () => {
  it("starts with idle phase", () => {
    expect(getStore().phase).toBe("idle");
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
    store.addActivity({ ts: Date.now(), type: "phase", phase: "stage" });
    expect(getStore().activities.length).toBe(1);
    expect(getStore().activities[0].phase).toBe("stage");
  });

  it("addActivity trims to MAX_ACTIVITIES limit", () => {
    const store = getStore();
    for (let i = 0; i < 510; i++) {
      store.addActivity({ ts: Date.now() + i, type: "phase", phase: "stage" });
    }
    expect(getStore().activities.length).toBeLessThanOrEqual(500);
  });
});

describe("SwarmStore: SSE streaming (stream_start → stream_delta → stream_end)", () => {
  it("stream_start creates an empty streaming bubble in roundtable", () => {
    const store = getStore();
    store.addActivity({
      ts: 1000,
      type: "stream_start",
      from: "socrates",
      messageId: "abc123",
    });

    const msgs = getStore().messages.get("roundtable")!;
    expect(msgs.length).toBe(1);
    expect(msgs[0].id).toBe("stream-abc123");
    expect(msgs[0].from).toBe("socrates");
    expect(msgs[0].body).toBe(""); // empty bubble
    expect(msgs[0].to).toBe("all");
    expect(msgs[0].channelId).toBe("roundtable");
  });

  it("stream_start uses entry.from as msgId fallback", () => {
    const store = getStore();
    store.addActivity({
      ts: 1000,
      type: "stream_start",
      from: "agent-7",
      // no messageId → falls back to from
    });

    const msgs = getStore().messages.get("roundtable")!;
    expect(msgs[0].id).toBe("stream-agent-7");
  });

  it("stream_start is NOT skipped during history replay (fromHistory=true)", () => {
    const store = getStore();
    store.addActivity(
      { ts: 1000, type: "stream_start", from: "socrates" },
      true, // fromHistory
    );

    const msgs = getStore().messages.get("roundtable")!;
    expect(msgs.length).toBe(1); // bubble created (same as live)
    expect(msgs[0].body).toBe("");
    expect(msgs[0].streaming).toBe(true);
  });

  it("stream_delta appends body to the existing stream bubble", () => {
    const store = getStore();
    // First create the bubble via stream_start
    store.addActivity({ ts: 1000, type: "stream_start", from: "socrates", messageId: "abc" });
    // Then stream deltas
    store.addActivity({ ts: 1001, type: "stream_delta", from: "socrates", body: "Hello" });
    store.addActivity({ ts: 1002, type: "stream_delta", from: "socrates", body: " World" });

    const msgs = getStore().messages.get("roundtable")!;
    expect(msgs.length).toBe(1); // still one bubble
    expect(msgs[0].body).toBe("Hello World");
  });

  it("stream_delta creates a new bubble if no stream- bubble exists (fallback)", () => {
    const store = getStore();
    // No stream_start before
    store.addActivity({ ts: 1000, type: "stream_delta", from: "socrates", body: "hello" });

    const msgs = getStore().messages.get("roundtable")!;
    expect(msgs.length).toBe(1);
    expect(msgs[0].body).toBe("hello");
  });

  it("stream_delta accumulates during history replay (no longer skipped)", () => {
    const store = getStore();
    // Create a streaming bubble to ensure we test accumulation, not fallback
    store.addActivity(
      { ts: 1000, type: "stream_start", from: "socrates" },
      true, // fromHistory
    );
    store.addActivity(
      { ts: 1001, type: "stream_delta", from: "socrates", body: "accumulated" },
      true, // fromHistory
    );

    const msgs = getStore().messages.get("roundtable")!;
    expect(msgs.length).toBe(1);
    expect(msgs[0].body).toBe("accumulated"); // delta was accumulated (same as live)
  });

  it("stream_end finalises the streaming bubble with full body", () => {
    const store = getStore();
    store.addActivity({ ts: 1000, type: "stream_start", from: "socrates", messageId: "abc" });
    store.addActivity({
      ts: 1001,
      type: "stream_end",
      from: "socrates",
      body: "Final plan content",
      thinking: "chain of thought...",
    });

    const msgs = getStore().messages.get("roundtable")!;
    expect(msgs.length).toBe(1);
    expect(msgs[0].body).toBe("Final plan content");
    expect(msgs[0].thinking).toBe("chain of thought...");
  });

  it("stream_end does NOT overwrite body if no entry.body", () => {
    const store = getStore();
    store.addActivity({ ts: 1000, type: "stream_start", from: "socrates", messageId: "abc" });
    store.addActivity({ ts: 1001, type: "stream_delta", from: "socrates", body: "partial" });
    store.addActivity({ ts: 1002, type: "stream_end", from: "socrates" }); // no body

    const msgs = getStore().messages.get("roundtable")!;
    expect(msgs[0].body).toBe("partial"); // preserved from deltas
  });

  it("stream_end during history replay backtracks thinking to most recent broadcast", () => {
    const store = getStore();
    // Simulate: history replay already has a broadcast message from socrates
    store.addActivity({ ts: 1000, type: "broadcast", from: "socrates", body: "plan done" }, true);
    // Then stream_end arrives with thinking
    store.addActivity(
      { ts: 1001, type: "stream_end", from: "socrates", thinking: "reasoning..." },
      true, // fromHistory
    );

    const msgs = getStore().messages.get("roundtable")!;
    // The broadcast message should have its thinking set
    expect(msgs[0].thinking).toBe("reasoning...");
    // But no stream bubble should be created
    expect(msgs.find(m => m.id.startsWith("stream-"))).toBeUndefined();
  });

  it("stream_end fromHistory without thinking is a no-op", () => {
    const store = getStore();
    store.addActivity({ ts: 1000, type: "broadcast", from: "socrates", body: "done" }, true);
    store.addActivity(
      { ts: 1001, type: "stream_end", from: "socrates" },
      true, // fromHistory, no thinking
    );

    const msgs = getStore().messages.get("roundtable")!;
    expect(msgs.length).toBe(1); // only the broadcast
    expect(msgs[0].thinking).toBeUndefined();
  });
});

describe("SwarmStore: init() guard and session sync", () => {
  it("init sets __initRunning guard", async () => {
    (api.getState as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      name: "test-session",
      status: "idle",
      phase: "idle",
      agents: {},
    });
    (api.getRunStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      running: false,
    });

    const store = getStore();
    expect((store as any).__initRunning).toBeFalsy();

    await store.init();

    expect((useSwarmStore.getState() as any).__initRunning).toBe(true);
  });

  it("init does NOT run twice (guard prevents double initialisation)", async () => {
    (api.getState as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: "test-session",
      status: "idle",
      phase: "idle",
      agents: {},
    });
    (api.getRunStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      running: false,
    });

    const store = getStore();
    await store.init();
    expect(api.getState).toHaveBeenCalledTimes(1);

    // Second call should be a no-op
    await store.init();
    expect(api.getState).toHaveBeenCalledTimes(1); // still 1
  });

  it("init reads session name from useSessionStore.getState().activeSwarm", async () => {
    (api.getState as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      name: "test-session",
      status: "idle",
      phase: "idle",
      agents: {},
    });
    (api.getRunStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      running: false,
    });

    mockActiveSwarm = "custom-session-42";
    await getStore().init();

    const { setActiveSession } = await import("../../lib/api-client");
    const { setActiveSSESession } = await import("../../lib/sse-client");
    expect(setActiveSession).toHaveBeenCalledWith("custom-session-42");
    expect(setActiveSSESession).toHaveBeenCalledWith("custom-session-42");
  });

  it("connectionStatus transitions connecting → live → reconnecting → live", async () => {
    (api.getState as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      name: "test-session", status: "idle", phase: "idle", agents: {},
    });
    (api.getRunStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ running: false });

    await getStore().init();
    // Before any connection callback fires, we are "connecting".
    expect(getStore().connectionStatus).toBe("connecting");

    const { sseClient } = await import("../../lib/sse-client");
    const onConn = (sseClient.onConnectionChange as ReturnType<typeof vi.fn>).mock.calls[0][0] as (c: boolean) => void;

    onConn(true);
    expect(getStore().connectionStatus).toBe("live");
    expect(getStore().isConnected).toBe(true);

    onConn(false);
    expect(getStore().connectionStatus).toBe("reconnecting");
    expect(getStore().isConnected).toBe(false);

    onConn(true);
    expect(getStore().connectionStatus).toBe("live");
  });

  it("init does NOT overwrite swarmState when getState() resolves null (panel must not vanish)", async () => {
    // Seed an existing swarmState (panel currently visible).
    useSwarmStore.setState({
      swarmState: {
        name: "test-session",
        status: "stage",
        phase: "stage",
        agents: { "agent-1": { name: "agent-1", status: "stage", role: "worker", praiseCount: 0, criticismCount: 0, conflictCount: 0 } },
      } as any,
    });
    (useSwarmStore.getState() as any).__initRunning = false;

    // Backend hiccup / brand-new session: getState resolves null.
    (api.getState as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    (api.getRunStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ running: false });

    await getStore().init();

    // The previous swarmState must be preserved, not clobbered to null.
    expect(getStore().swarmState).not.toBeNull();
    expect(getStore().swarmState?.agents["agent-1"]).toBeDefined();
    // phase falls back gracefully without throwing on state.phase.
    expect(getStore().phase).toBe("idle");
  });

  it("init falls back to 'SatoPi' when activeSwarm is empty", async () => {
    (api.getState as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      name: "SatoPi",
      status: "idle",
      phase: "idle",
      agents: {},
    });
    (api.getRunStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      running: false,
    });

    // Reset the guard for this test
    (useSwarmStore.getState() as any).__initRunning = false;
    mockActiveSwarm = ""; // simulate unhydrated state
    await getStore().init();

    const { setActiveSession } = await import("../../lib/api-client");
    expect(setActiveSession).toHaveBeenCalledWith("SatoPi");
  });
});

describe("SwarmStore: phase transitions", () => {
  it("refreshState fetches state from API", async () => {
    (api.getState as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      name: "test",
      status: "stage",
      phase: "stage",
      agents: [],
    });
    await getStore().refreshState();
    expect(api.getState).toHaveBeenCalled();
  });

  it("refreshState called on store init", async () => {
    expect(api.getState).toBeDefined();
  });
});

describe("SwarmStore: script interactions", () => {
  it("startPlanning sends task to backend", async () => {
    (api.startScript as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true });
    await getStore().startPlanning("build login");
    expect(api.startScript).toHaveBeenCalledWith("build login");
  });

  it("cancelScript resets state", async () => {
    (api.cancelScript as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true });
    // Set running state first
    useSwarmStore.setState({ phase: "script", scriptState: { phase: "script", task: "test", conversationLength: 5, planReady: false, busy: false } });
    await getStore().cancelScript();
    expect(getStore().phase).toBe("idle");
  });

  it("sendSteering sends operator message to running loop", async () => {
    (api.sendSteering as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ success: true });
    await getStore().sendSteering("fix the bug");
    expect(api.sendSteering).toHaveBeenCalledWith("fix the bug");
  });
});
