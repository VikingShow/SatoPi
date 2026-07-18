/**
 * Swarm store — real-time swarm state + SSE event buffer.
 *
 * Maintains the current SwarmState (polled via REST) and a ring buffer
 * of recent ActivityEntry events (pushed via SSE). Also manages the
 * chat channel list derived from activity events.
 */

import { create } from "zustand";
import { toast } from "sonner";
import type { SwarmState, ActivityEntry, ChatChannel, ChatMessage, AfterLoopResult, LoopPhase, BeforeLoopState, TodoItem, BlockerContext, BlockerResolution } from "../lib/types";
import { api } from "../lib/api-client";
import { sseClient } from "../lib/sse-client";

const MAX_ACTIVITIES = 500;

interface SwarmStore {
  swarmState: SwarmState | null;
  activities: ActivityEntry[];
  channels: Map<string, ChatChannel>;
  messages: Map<string, ChatMessage[]>;
  activeChannelId: string | null;
  isConnected: boolean;
  isRunning: boolean;
  loopPhase: LoopPhase;
  beforeLoopState: BeforeLoopState | null;
  planVersion: number;
  todos: TodoItem[];
  afterLoopResult: AfterLoopResult | null;
  blockerContext: BlockerContext | null;
  error: string | null;

  init: () => Promise<void>;
  setActiveChannel: (id: string) => void;
  addActivity: (entry: ActivityEntry, fromHistory?: boolean) => void;
  refreshState: () => Promise<void>;
  startRun: () => Promise<void>;
  stopRun: () => Promise<void>;
  fetchAfterLoopResult: () => Promise<void>;

  // Before Loop actions
  startPlanning: (task: string) => Promise<void>;
  sendBeforeLoopMessage: (text: string) => Promise<void>;
  runDebate: () => Promise<void>;
  confirmAndStart: () => Promise<void>;
  cancelBeforeLoop: () => Promise<void>;
  refreshBeforeLoopState: () => Promise<void>;

  // Steering (during running loop)
  sendSteering: (text: string) => Promise<void>;

  // Blocker resolution
  resolveBlocker: (decision: BlockerResolution) => Promise<void>;
}

function deriveChannel(entry: ActivityEntry): { id: string; channel: ChatChannel; message: ChatMessage } | null {
  const ts = entry.ts;
  switch (entry.type) {
    case "broadcast": {
      const id = "roundtable";
      return {
        id,
        channel: { id, type: "roundtable", name: "Roundtable", participants: [], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
        message: { id: `${ts}-${entry.from}`, channelId: id, from: entry.from ?? "", to: "all", body: entry.body ?? "", timestamp: ts },
      };
    }
    case "subgroup": {
      const id = `subgroup-${entry.to}`;
      return {
        id,
        channel: { id, type: "subgroup", name: `#${entry.to}`, participants: [], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
        message: { id: `${ts}-${entry.from}`, channelId: id, from: entry.from ?? "", to: entry.to ?? "", body: entry.body ?? "", timestamp: ts },
      };
    }
    case "steering": {
      // Operator steering to "all" → goes to roundtable (main chat)
      if (entry.from === "operator" && entry.to === "all") {
        const id = "roundtable";
        return {
          id,
          channel: { id, type: "roundtable", name: "Roundtable", participants: [], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
          message: { id: `${ts}-${entry.from}`, channelId: id, from: entry.from ?? "", to: entry.to ?? "", body: entry.body ?? "", timestamp: ts },
        };
      }
      const id = `steering-${entry.from}-${entry.to}`;
      return {
        id,
        channel: { id, type: "steering", name: `${entry.from} -> ${entry.to}`, participants: [entry.from ?? "", entry.to ?? ""], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
        message: { id: `${ts}-${entry.from}`, channelId: id, from: entry.from ?? "", to: entry.to ?? "", body: entry.body ?? "", timestamp: ts },
      };
    }
    default:
      return null;
  }
}

// ── Helper: optimistically push a user message into the roundtable channel ──

function pushUserMessage(
  setFn: (partial: Partial<SwarmStore> | ((state: SwarmStore) => Partial<SwarmStore>)) => void,
  body: string,
) {
  const ts = Date.now();
  setFn((state) => {
    const messages = new Map(state.messages);
    const channels = new Map(state.channels);
    const msgList = messages.get("roundtable") ?? [];
    msgList.push({
      id: `local-${ts}-operator`,
      channelId: "roundtable",
      from: "operator",
      to: "all",
      body,
      timestamp: ts,
    });
    messages.set("roundtable", msgList);
    if (!channels.has("roundtable")) {
      channels.set("roundtable", {
        id: "roundtable",
        type: "roundtable",
        name: "Roundtable",
        participants: [],
        unreadCount: 0,
        lastMessage: body,
        lastMessageTime: ts,
      });
    } else {
      channels.get("roundtable")!.lastMessage = body;
      channels.get("roundtable")!.lastMessageTime = ts;
    }
    return { messages, channels };
  });
}

export const useSwarmStore = create<SwarmStore>((set, get) => ({
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

  init: async () => {
    try {
      const [state, runStatus] = await Promise.all([
        api.getState(),
        api.getRunStatus(),
      ]);
      set({
        swarmState: state,
        isRunning: runStatus.running,
        loopPhase: state.loopPhase ?? (runStatus.running ? "running" : "idle"),
        error: null,
      });

      // Fetch before-loop state if in a before-loop phase
      const phase = get().loopPhase;
      if (phase.startsWith("before-loop")) {
        try {
          const blState = await api.getBeforeLoopState();
          set({ beforeLoopState: blState });

          // Load persisted conversation history so page refresh doesn't lose dialogue
          try {
            const { history } = await api.getBeforeLoopHistory();
            const messages = new Map(get().messages);
            const channels = new Map(get().channels);
            const msgList: ChatMessage[] = [];
            for (let i = 0; i < history.length; i++) {
              const turn = history[i];
              const from = turn.role === "user" ? "operator" : "socrates";
              msgList.push({
                id: `history-${i}-${turn.role}`,
                channelId: "roundtable",
                from,
                to: "all",
                body: turn.content,
                timestamp: 0,
              });
            }
            if (msgList.length > 0) {
              messages.set("roundtable", msgList);
              if (!channels.has("roundtable")) {
                channels.set("roundtable", {
                  id: "roundtable",
                  type: "roundtable",
                  name: "Roundtable",
                  participants: [],
                  unreadCount: 0,
                  lastMessage: msgList[msgList.length - 1].body,
                  lastMessageTime: msgList[msgList.length - 1].timestamp,
                });
              }
              set({ messages, channels });
            }
          } catch {
            // History endpoint might not be available
          }
        } catch {
          // might not be available
        }
      }

      // Fetch any existing after-loop result from a previous run
      try {
        const afterLoop = await api.getAfterLoopSummary();
        set({ afterLoopResult: afterLoop });
      } catch {
        // 404 is expected when no run has completed yet
      }

      // Load historical activity log to restore conversation display
      try {
        const { entries } = await api.getHistory();
        const activityEntries = entries as ActivityEntry[];
        // Replay history through addActivity (fromHistory=true to include operator messages)
        for (const entry of activityEntries) {
          get().addActivity(entry, true);
        }
      } catch {
        // History might not be available yet
      }

      sseClient.connect();
      sseClient.on((entry) => {
        get().addActivity(entry);
        set({ isConnected: sseClient.isConnected });

        // Handle phase events for loop phase transitions
        if (entry.type === "phase") {
          const p = entry.phase ?? "";

          // Plan updated → increment planVersion so PlanViewer auto-refreshes
          if (p === "plan-updated") {
            set((s) => ({ planVersion: s.planVersion + 1 }));
          }

          // Todo updated → refresh state to get latest todos
          if (p === "todo-updated") {
            setTimeout(() => get().refreshState(), 100);
          }

          // After-loop-done → fetch result
          if (p === "after-loop-done") {
            setTimeout(() => get().fetchAfterLoopResult(), 500);
          }

          // Blockage detected → set blocked phase
          if (p === "blocked") {
            set({ loopPhase: "blocked" });
            toast.warning("Swarm Blocked", { description: "The swarm has encountered a blocker and is waiting for your decision." });
          }

          // Blocker resolved → back to running
          if (p === "running" && get().loopPhase === "blocked") {
            set({ loopPhase: "running", blockerContext: null });
          }

          // Refresh before-loop state on relevant phase events
          if (p.startsWith("before-loop") || p === "debate-start" || p === "debate-done") {
            setTimeout(() => get().refreshBeforeLoopState(), 300);
          }
        }

        // Broadcast messages in before-loop: also refresh before-loop state
        // (to detect planReady changes)
        if (entry.type === "broadcast" && entry.from === "socrates") {
          setTimeout(() => get().refreshBeforeLoopState(), 300);
        }

        // System broadcast carrying blocker context JSON
        if (entry.type === "broadcast" && entry.from === "system" && entry.body) {
          try {
            const parsed = JSON.parse(entry.body);
            if (parsed?.type === "blocker" && parsed?.context) {
              set({ blockerContext: parsed.context as BlockerContext });
              toast.error("Blocker Detected", { description: (parsed.context as BlockerContext)?.reason ?? "A blocker requires your attention" });
            }
          } catch {
            // Not JSON or not a blocker message — ignore
          }
        }
      });

      // Poll state + run status every 5s
      setInterval(() => get().refreshState(), 5000);
    } catch (err) {
      set({ error: String(err) });
    }
  },

  setActiveChannel: (id) => set({ activeChannelId: id }),

  addActivity: (entry, fromHistory = false) => {
    set((state) => {
      const activities = [...state.activities, entry].slice(-MAX_ACTIVITIES);
      const channels = new Map(state.channels);
      const messages = new Map(state.messages);

      const derived = deriveChannel(entry);
      if (derived) {
        // In live mode, skip operator echo messages — we add them optimistically
        // In history mode, include all messages (loading from scratch)
        const isOperatorEcho = !fromHistory &&
          (entry.type === "broadcast" || entry.type === "steering") &&
          entry.from === "operator";

        const existing = channels.get(derived.id);
        if (!existing) {
          channels.set(derived.id, derived.channel);
        } else {
          existing.lastMessage = derived.channel.lastMessage;
          existing.lastMessageTime = derived.channel.lastMessageTime;
          if (state.activeChannelId !== derived.id) existing.unreadCount++;
        }

        if (!isOperatorEcho) {
          const msgList = messages.get(derived.id) ?? [];
          msgList.push(derived.message);
          messages.set(derived.id, msgList);
        }
      }

      return { activities, channels, messages };
    });
  },

  refreshState: async () => {
    try {
      const [state, runStatus] = await Promise.all([
        api.getState(),
        api.getRunStatus(),
      ]);
      const wasRunning = get().isRunning;
      const nowRunning = runStatus.running;
      const polledPhase = state.loopPhase ?? (nowRunning ? "running" : "idle");

      // Don't overwrite "blocked" phase from polling if we're still blocked
      // (the backend sets loopPhase="blocked" and keeps it until resolved)
      const currentPhase = get().loopPhase;
      const newPhase = (currentPhase === "blocked" && polledPhase === "blocked")
        ? "blocked"
        : polledPhase;

      set({
        swarmState: state,
        isRunning: nowRunning,
        loopPhase: newPhase,
        todos: state.todos ?? [],
        error: null,
      });

      // When a run transitions from running → stopped, fetch after-loop result
      if (wasRunning && !nowRunning) {
        // Small delay to let the after-loop pipeline finish writing
        setTimeout(() => get().fetchAfterLoopResult(), 1000);
      }
    } catch (err) {
      set({ error: String(err) });
    }
  },

  startRun: async () => {
    try {
      const result = await api.startRun();
      if (result.success) {
        set({ isRunning: true, loopPhase: "running", afterLoopResult: null, error: null });
      } else {
        set({ error: result.error ?? "Failed to start" });
      }
    } catch (err) {
      set({ error: String(err) });
    }
  },

  stopRun: async () => {
    try {
      const result = await api.stopRun();
      if (result.success) {
        set({ isRunning: false, error: null });
      } else {
        set({ error: result.error ?? "Failed to stop" });
      }
    } catch (err) {
      set({ error: String(err) });
    }
  },

  fetchAfterLoopResult: async () => {
    try {
      const result = await api.getAfterLoopSummary();
      set({ afterLoopResult: result, loopPhase: "idle" });
    } catch {
      // 404 is expected when no after-loop result is available
    }
  },

  // ── Before Loop actions ──

  startPlanning: async (task: string) => {
    // Optimistically add user's message to chat for instant display
    pushUserMessage(set, task);
    try {
      const result = await api.startBeforeLoop(task);
      if (result.success) {
        set({ loopPhase: "before-loop-dialog", error: null });
        // Switch to roundtable channel to see Socrates dialogue
        set({ activeChannelId: "roundtable" });
        // Refresh before-loop state
        setTimeout(() => get().refreshBeforeLoopState(), 500);
      } else {
        set({ error: result.error ?? "Failed to start planning" });
      }
    } catch (err) {
      set({ error: String(err) });
    }
  },

  sendBeforeLoopMessage: async (text: string) => {
    // Optimistically add user's message to chat for instant display
    pushUserMessage(set, text);
    try {
      const result = await api.sendBeforeLoopMessage(text);
      if (!result.success) {
        set({ error: result.error ?? "Failed to send message" });
      }
      // The message and Socrates response will arrive via SSE
    } catch (err) {
      set({ error: String(err) });
    }
  },

  runDebate: async () => {
    try {
      const result = await api.runDebate();
      if (result.success) {
        set({ loopPhase: "before-loop-debate", error: null });
      } else {
        set({ error: result.error ?? "Failed to start debate" });
      }
    } catch (err) {
      set({ error: String(err) });
    }
  },

  confirmAndStart: async () => {
    try {
      const result = await api.confirmBeforeLoop();
      if (result.success) {
        set({ loopPhase: "running", isRunning: true, afterLoopResult: null, error: null });
      } else {
        set({ error: result.error ?? "Failed to confirm" });
      }
    } catch (err) {
      set({ error: String(err) });
    }
  },

  cancelBeforeLoop: async () => {
    try {
      const result = await api.cancelBeforeLoop();
      if (result.success) {
        set({ loopPhase: "idle", beforeLoopState: null, error: null });
      } else {
        set({ error: result.error ?? "Failed to cancel" });
      }
    } catch (err) {
      set({ error: String(err) });
    }
  },

  refreshBeforeLoopState: async () => {
    try {
      const blState = await api.getBeforeLoopState();
      set({ beforeLoopState: blState, loopPhase: blState.phase });

      // If debate finished, update phase
      if (blState.phase === "before-loop-confirm") {
        set({ loopPhase: "before-loop-confirm" });
      }
    } catch {
      // Before-loop manager might not be available
    }
  },

  // ── Steering (during running loop) ──

  sendSteering: async (text: string) => {
    // Optimistically add user's steering message to chat for instant display
    pushUserMessage(set, text);
    try {
      const result = await api.sendSteering(text);
      if (!result.success) {
        set({ error: result.error ?? "Failed to send steering message" });
      }
      // The steering message will arrive via SSE (logSteering → steering channel)
    } catch (err) {
      set({ error: String(err) });
    }
  },

  // ── Blocker resolution ──

  resolveBlocker: async (decision: BlockerResolution) => {
    try {
      const result = await api.resolveBlocker(decision);
      if (result.success) {
        set({ blockerContext: null, loopPhase: decision === "abort" ? "idle" : "running", error: null });
      } else {
        set({ error: result.error ?? "Failed to resolve blocker" });
      }
    } catch (err) {
      set({ error: String(err) });
    }
  },
}));
