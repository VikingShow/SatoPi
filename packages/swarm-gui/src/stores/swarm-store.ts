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
  /** P2-5: Latest convergence values for trend display. */
  convergenceHistory: Array<{ ts: number; jaccard: number; converged: boolean }>;

  /** P2-10: Tool-call log for AgentTimeline visualization. */
  toolCalls: Map<string, Array<{ ts: number; tool: string; file?: string; duration?: number; tokens?: number; exitCode?: number }>>;
  /** File changes tracked for FileChangesPanel. */
  fileChanges: Array<{ ts: number; agent: string; file: string; action: string; linesChanged?: number }>;

  init: () => Promise<void>;
  setActiveChannel: (id: string) => void;
  addActivity: (entry: ActivityEntry, fromHistory?: boolean) => void;
  refreshState: () => Promise<void>;
  startRun: () => Promise<void>;
  stopRun: () => Promise<void>;
  fetchAfterLoopResult: () => Promise<void>;

  // Pause / Resume
  pauseRun: () => Promise<void>;
  resumeRun: () => Promise<void>;

  // Before Loop actions
  startPlanning: (task: string) => Promise<void>;
  sendBeforeLoopMessage: (text: string) => Promise<void>;
  runDebate: () => Promise<void>;
  confirmAndStart: () => Promise<void>;
  cancelBeforeLoop: () => Promise<void>;
  refreshBeforeLoopState: () => Promise<void>;
  /** P2-2: Load before-loop conversation history. */
  loadBeforeLoopHistory: () => Promise<Array<{ role: string; content: string }>>;

  // Steering (during running loop)
  sendSteering: (text: string) => Promise<void>;

  // Blocker resolution
  resolveBlocker: (decision: BlockerResolution) => Promise<void>;
}

function deriveChannel(entry: ActivityEntry, seq: number): { id: string; channel: ChatChannel; message: ChatMessage } | null {
  const ts = entry.ts;
  switch (entry.type) {
    case "broadcast": {
      const id = "roundtable";
      return {
        id,
        channel: { id, type: "roundtable", name: "Roundtable", participants: [], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
        message: { id: `${ts}-${entry.from}-${seq}`, channelId: id, from: entry.from ?? "", to: "all", body: entry.body ?? "", timestamp: ts },
      };
    }
    case "subgroup": {
      const id = `subgroup-${entry.to}`;
      return {
        id,
        channel: { id, type: "subgroup", name: `#${entry.to}`, participants: [], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
        message: { id: `${ts}-${entry.from}-${seq}`, channelId: id, from: entry.from ?? "", to: entry.to ?? "", body: entry.body ?? "", timestamp: ts },
      };
    }
    case "steering": {
      // Operator steering to "all" → goes to roundtable (main chat)
      if (entry.from === "operator" && entry.to === "all") {
        const id = "roundtable";
        return {
          id,
          channel: { id, type: "roundtable", name: "Roundtable", participants: [], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
          message: { id: `${ts}-${entry.from}-${seq}`, channelId: id, from: entry.from ?? "", to: entry.to ?? "", body: entry.body ?? "", timestamp: ts },
        };
      }
      const id = `steering-${entry.from}-${entry.to}`;
      return {
        id,
        channel: { id, type: "steering", name: `${entry.from} -> ${entry.to}`, participants: [entry.from ?? "", entry.to ?? ""], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
        message: { id: `${ts}-${entry.from}-${seq}`, channelId: id, from: entry.from ?? "", to: entry.to ?? "", body: entry.body ?? "", timestamp: ts },
      };
    }
    // P2-10: Tool calls appear in the roundtable as system-style messages.
    case "tool_call": {
      const id = "roundtable";
      const status = entry.toolError ? "FAILED" : entry.toolDurationMs ? `OK (${(entry.toolDurationMs / 1000).toFixed(1)}s)` : "OK";
      const body = `🔧 **${entry.toolName}** ${status}${entry.toolError ? ` — ${entry.toolError}` : ""}`;
      return {
        id,
        channel: { id, type: "roundtable", name: "Roundtable", participants: [], unreadCount: 0, lastMessage: body, lastMessageTime: ts },
        message: { id: `${ts}-tool-${entry.toolName}-${seq}`, channelId: id, from: entry.worker ?? "agent", to: "all", body, timestamp: ts },
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
  // Add a high-resolution counter suffix to ensure uniqueness even if the user
  // sends multiple messages in the same millisecond
  const id = `local-${ts}-operator-${Math.random().toString(36).slice(2, 8)}`;
  setFn((state) => {
    const messages = new Map(state.messages);
    const channels = new Map(state.channels);
    const msgList = messages.get("roundtable") ?? [];
    msgList.push({
      id,
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
  convergenceHistory: [],
  toolCalls: new Map(),
  fileChanges: [],

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
          // Conversation history is NOT loaded separately — the activity log
          // replay below (api.getHistory → addActivity) already carries every
          // broadcast event (operator + socrates messages) from session.jsonl.
          // Loading conversation turns in parallel would create duplicate
          // ChatMessages with different IDs, doubling every message in chat.
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

      // P3-3: Track last event timestamp for reconnection recovery.
      let lastEventTs = 0;
      sseClient.onConnectionChange((connected) => {
        set({ isConnected: connected });
        if (connected && lastEventTs > 0) {
          // Reconnected — fetch missed events since last seen timestamp.
          import("../lib/api-client").then(({ api }) => {
            fetch(`/api/history?since=${lastEventTs}`)
              .then(r => r.json())
              .then((data: { entries?: Array<{ ts: number }> }) => {
                const missed = (data.entries ?? []).filter((e: { ts: number }) => e.ts > lastEventTs);
                missed.forEach((e: unknown) => get().addActivity(e as import("../lib/types").ActivityEntry, true));
                if (missed.length > 0) {
                  toast(`Reconnected — loaded ${missed.length} missed events`, { duration: 3000 });
                }
              })
              .catch(() => {});
          });
        }
      });
      sseClient.connect();
      sseClient.on((entry) => {
        lastEventTs = Math.max(lastEventTs, entry.ts);
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

        // P2-5: Track convergence events.
        if (entry.type === "convergence" && entry.jaccard !== undefined) {
          set((s) => ({
            convergenceHistory: [
              ...s.convergenceHistory,
              { ts: entry.ts, jaccard: entry.jaccard!, converged: entry.converged ?? false },
            ].slice(-20),
          }));
        }

        // P2-3: Steering ack — show delivery confirmation.
        if (entry.type === "steering_ack") {
          toast.success(`Steering delivered to ${entry.acknowledgedBy ?? "worker"}`, { duration: 2000 });
        }

        // P2-10: Tool call — show in-line tool execution indicator.
        if (entry.type === "tool_call" && entry.toolName) {
          // Tool calls are captured via addActivity → deriveChannel for chat display.
          // The toast provides a transient notification for long-running tools.
          if (entry.toolDurationMs && entry.toolDurationMs > 3000) {
            toast(`${entry.worker ?? "agent"}: ${entry.toolName} (${(entry.toolDurationMs / 1000).toFixed(1)}s)`, {
              description: entry.toolError ? `Error: ${entry.toolError}` : entry.toolOutput?.slice(0, 200),
              duration: 3000,
            });
          }

          // Populate toolCalls for AgentTimeline
          set((s) => {
            const toolCalls = new Map(s.toolCalls);
            const agent = entry.worker ?? entry.from ?? "unknown";
            const agentCalls = [...(toolCalls.get(agent) ?? [])];
            const call = {
              ts: entry.ts,
              tool: entry.toolName,
              duration: entry.toolDurationMs ?? undefined,
              exitCode: (entry.toolError ? 1 : 0) as number | undefined,
            } as { ts: number; tool: string; file?: string; duration?: number; tokens?: number; exitCode?: number };
            if (entry.file) {
              call.file = entry.file;
            }
            agentCalls.push(call);
            toolCalls.set(agent, agentCalls);
            return { toolCalls };
          });
        }

        // Track file_change events for FileChangesPanel
        if (entry.type === "file_change" && entry.file) {
          set((s) => ({
            fileChanges: [...s.fileChanges, {
              ts: entry.ts,
              agent: entry.worker ?? entry.from ?? "unknown",
              file: entry.file!,
              action: entry.action ?? "modified",
              linesChanged: entry.linesChanged,
            }],
          }));
        }

        // P2-11: Error flag — categorized error notification.
        if (entry.type === "error_flag" && entry.errorFlag) {
          const suggestions: Record<string, string> = {
            ContextOverflow: "Consider using /shake to free context space.",
            UsageLimit: "API quota exhausted — switch credential or wait.",
            AuthFailed: "Authentication failed — re-login required.",
            Transient: "Temporary error — automatic retry in progress.",
          };
          const hint = suggestions[entry.errorFlag] ?? entry.suggestion;
          toast.error(
            entry.recoverable ? `Recoverable: ${entry.errorFlag}` : `${entry.errorFlag}`,
            { description: hint ? `${entry.body ?? ""} — ${hint}` : entry.body, duration: 8000 },
          );
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

      // ── Streaming delta: append to the last streaming bubble ──
      if (entry.type === "stream_delta" && entry.from) {
        const msgId = (entry as any).messageId ?? entry.from;
        const msgList = [...(messages.get("roundtable") ?? [])];
        const lastMsg = msgList[msgList.length - 1];
        if (lastMsg && lastMsg.id.startsWith(`stream-`)) {
          lastMsg.body += (entry.body ?? "");
        } else {
          msgList.push({
            id: `stream-${String(msgId)}`,
            channelId: "roundtable",
            from: entry.from,
            to: "all",
            body: entry.body ?? "",
            timestamp: entry.ts,
          } as ChatMessage);
        }
        messages.set("roundtable", msgList);
        return { activities, channels, messages };
      }

      // ── Stream end: finalise the streaming bubble ──
      if (entry.type === "stream_end" && entry.from) {
        const msgList = [...(messages.get("roundtable") ?? [])];
        const lastMsg = msgList[msgList.length - 1];
        if (lastMsg && lastMsg.id.startsWith("stream-") && entry.body) {
          lastMsg.body = entry.body;
        }
        messages.set("roundtable", msgList);
        return { activities, channels, messages };
      }

      // ── Standard (non-streaming) message ──
      const seq = state.activities.length;
      const derived = deriveChannel(entry, seq);
      if (derived) {
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
          const msgList = [...(messages.get(derived.id) ?? [])];
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

  // ── Pause / Resume ──

  pauseRun: async () => {
    try {
      const result = await api.pauseRun();
      if (result.success) {
        set({ loopPhase: "paused" });
        toast.info("Swarm Paused", { description: "Workers have been paused. Click Resume to continue." });
      } else {
        toast.error("Failed to pause", { description: result.error ?? "Unknown error" });
      }
    } catch (err) {
      toast.error("Failed to pause", { description: String(err) });
    }
  },

  resumeRun: async () => {
    try {
      const result = await api.resumeRun();
      if (result.success) {
        set({ loopPhase: "running" });
        toast.success("Swarm Resumed", { description: "Workers are continuing." });
      } else {
        toast.error("Failed to resume", { description: result.error ?? "Unknown error" });
      }
    } catch (err) {
      toast.error("Failed to resume", { description: String(err) });
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

  // P2-2: Load before-loop conversation history.
  loadBeforeLoopHistory: async () => {
    try {
      const result = await api.getBeforeLoopHistory();
      return result.history ?? [];
    } catch {
      return [];
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
        if (decision === "abort") {
          toast.info("Run Aborted", { description: "The swarm run has been stopped." });
        }
      } else {
        set({ error: result.error ?? "Failed to resolve blocker" });
        toast.error("Failed", { description: result.error ?? "Could not resolve the blocker. Try again." });
      }
    } catch (err) {
      set({ error: String(err) });
      toast.error("Failed", { description: String(err) });
    }
  },
}));
