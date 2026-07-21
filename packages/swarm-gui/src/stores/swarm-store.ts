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
import { api, setActiveSession } from "../lib/api-client";
import { sseClient, setActiveSSESession } from "../lib/sse-client";
import { useSessionStore } from "./session-store";

const MAX_ACTIVITIES = 500;

/**
 * The set of LoopPhase values the backend SwarmStateMachine broadcasts as
 * authoritative phase events. The frontend adopts these verbatim (pure
 * projection). Other `phase` events (workers/cloner-review/todo-updated/…)
 * are sub-events and must NOT be treated as a LoopPhase.
 */
const AUTHORITATIVE_LOOP_PHASES = new Set<string>([
  "idle",
  "before-loop-dialog",
  "before-loop-debate",
  "before-loop-confirm",
  "running",
  "paused",
  "blocked",
  "after-loop",
]);

interface SwarmStore {
  swarmState: SwarmState | null;
  activities: ActivityEntry[];
  channels: Map<string, ChatChannel>;
  messages: Map<string, ChatMessage[]>;
  activeChannelId: string | null;
  isConnected: boolean;
  /**
   * Fine-grained connection lifecycle for the header indicator:
   * - "connecting"   — first attempt, never been live yet
   * - "live"         — SSE open, receiving events
   * - "reconnecting" — was live, lost the socket, auto-retrying
   */
  connectionStatus: "connecting" | "live" | "reconnecting";
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
    // ── Deliberation events → per-round deliberation channels ──
    case "deliberation_challenge":
    case "deliberation_rebuttal":
    case "deliberation_ruling": {
      const round = entry.round ?? 0;
      const phase = entry.type === "deliberation_challenge" ? "challenge" : entry.type === "deliberation_rebuttal" ? "rebuttal" : "ruling";
      const id = `deliberation-r${round}`;
      return {
        id,
        channel: { id, type: "deliberation", name: `Deliberation R${round}`, participants: [], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
        message: { id: `${ts}-${entry.from}-${seq}`, channelId: id, from: entry.from ?? "", to: "all", body: `[${phase}] ${entry.body ?? ""}`, timestamp: ts },
      };
    }

    // ── Per-cloner individual verdict → dedicated cloner channel ──
    case "cloner_individual": {
      const id = `cloner-${entry.from}`;
      const verdictLabel = entry.passed ? "PASS" : "FAIL";
      const body = `**${verdictLabel}**${entry.findings?.length ? `\n${(entry.findings as string[]).map((f: string) => `· ${f}`).join("\n")}` : ""}`;
      return {
        id,
        channel: { id, type: "cloner", name: `${entry.from}`, participants: [], unreadCount: 0, lastMessage: body, lastMessageTime: ts },
        message: { id: `${ts}-${entry.from}-${seq}`, channelId: id, from: entry.from ?? "", to: "all", body, timestamp: ts },
      };
    }

    // ── File coordination → per-file channel ──
    case "file_coordination": {
      const file = entry.file ?? "unknown";
      const id = `file-${file.replace(/[/.]/g, "-")}`;
      return {
        id,
        channel: { id, type: "file", name: file, participants: [], unreadCount: 0, lastMessage: entry.body, lastMessageTime: ts },
        message: { id: `${ts}-${entry.from}-${seq}`, channelId: id, from: entry.from ?? "", to: "all", body: entry.body ?? "", timestamp: ts },
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
    // Spread to create a new array reference — avoids useMemo caching
    // the same reference so React re-renders the message list.
    const msgList = [...(messages.get("roundtable") ?? [])];
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
  connectionStatus: "connecting",
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
    // Guard against duplicate initialisation (React Strict Mode
    // double-mounts effects, which would otherwise register a second
    // set of SSE listeners and cause every event to appear 2×/4×).
    if ((get() as any).__initRunning) return;
    (get() as any).__initRunning = true;

    try {
      // Sync the api/sse clients to the active session BEFORE any
      // session-scoped calls.  The session-store subscribe (see
      // session-store.ts) normally keeps these in sync, but during
      // first-ever mount the subscriber may not have fired yet.
      // Read directly from the session store's Zustand state instead of
      // the module-level getActiveSession(), which may be stale before
      // the persist middleware has rehydrated activeSwarm.
      const sessionName = useSessionStore.getState().activeSwarm || "SatoPi";
      setActiveSession(sessionName);

      // IMPORTANT: register connection-change listener BEFORE first connect.
      // setActiveSSESession already calls disconnect + connect, so if the SSE
      // connects before onConnectionChange is set up, isConnected stays false
      // forever — causing the UI to show "Reconnecting" indefinitely.
      // Re-register after setActiveSSESession too, in case disconnect() clears
      // internal listeners.
      // Connection lifecycle. Gap recovery is now handled at the transport
      // layer via SSE Last-Event-ID replay (the backend EventBus re-sends every
      // buffered event with seq > the client's last id on reconnect), so we no
      // longer replay via getHistory here — doing both would double-apply every
      // missed event since addActivity has no dedup.
      let hasConnectedOnce = false;
      const onConnChange = (connected: boolean) => {
        if (connected) {
          const wasReconnecting = hasConnectedOnce;
          hasConnectedOnce = true;
          set({ isConnected: true, connectionStatus: "live" });
          // Dedup: only toast on an actual reconnect (live→lost→live), not the
          // very first connect.
          if (wasReconnecting) {
            toast.success("Reconnected", { id: "sse-reconnect", description: "Syncing missed events…", duration: 2500 });
          }
        } else {
          set({
            isConnected: false,
            connectionStatus: hasConnectedOnce ? "reconnecting" : "connecting",
          });
        }
      };
      sseClient.onConnectionChange(onConnChange);

      // Initialize isConnected from the SSE client's current state — if the
      // subscriber in session-store.ts already connected (via persist hydration),
      // onConnectionChange may have already fired (or won't fire again since
      // the state didn't change).  We must seed isConnected here.
      if (sseClient.isConnected) {
        hasConnectedOnce = true;
        set({ isConnected: true, connectionStatus: "live" });
      } else {
        set({ isConnected: false, connectionStatus: "connecting" });
      }

      setActiveSSESession(sessionName);
      // SseClient.disconnect() does NOT clear connectionListeners (Set-based,
      // survives disconnect→connect cycles), so re-registration is unnecessary
      // and was causing the "Reconnected" toast to fire spuriously: the duplicate
      // callback on the second invocation saw hasConnectedOnce===true.

      try {
        const [state, runStatus] = await Promise.all([
          api.getState(),
          api.getRunStatus(),
        ]);
        // Null guard: for a brand-new session (or a transient backend hiccup)
        // getState() may resolve to null/undefined. We must NOT blindly overwrite
        // swarmState with a falsy value — that is what made the right-hand panel
        // vanish. Preserve any existing state and only merge when we actually
        // received one. loopPhase is also read defensively via optional chaining.
        set((prev) => ({
          swarmState: state ?? prev.swarmState,
          isRunning: runStatus.running,
          loopPhase: state?.loopPhase ?? (runStatus.running ? "running" : "idle"),
          error: null,
        }));
      } catch (apiErr: any) {
        const msg = String(apiErr?.message ?? apiErr);
        // If the stored session does not exist on the backend (stale from a
        // previous failed createSession, or was deleted externally), clean
        // up localStorage and fall back to the default "SatoPi" session.
        if (msg.includes("not found") || msg.includes("404")) {
          const { useSessionStore } = await import("./session-store");
          const { setActiveSession } = await import("../lib/api-client");
          const { setActiveSSESession } = await import("../lib/sse-client");
          const staleName = useSessionStore.getState().activeSwarm;
          useSessionStore.getState().deleteSession(staleName);
          const fallback = "SatoPi";
          setActiveSession(fallback);
          setActiveSSESession(fallback);
          set({ loopPhase: "idle", isRunning: false, error: null });
          // Re-init with the fallback session.
          (get() as any).__initRunning = false;
          get().init();
          return;
        }
        set({ error: msg });
      }

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

      // ── P1-2: token-level stream_delta batching ──────────────────────
      // High-frequency stream_delta events (one per token) would each trigger
      // a full messages-Map rebuild + re-render. We coalesce consecutive
      // deltas from the same source into a single addActivity call flushed
      // once per animation frame, cutting re-renders from O(tokens) to O(frames)
      // while preserving event ordering (any non-delta event flushes first).
      let deltaBuffer: { from: string; body: string; ts: number } | null = null;
      let flushHandle: ReturnType<typeof setTimeout> | number | null = null;
      const raf: (cb: () => void) => number =
        typeof requestAnimationFrame !== "undefined"
          ? (cb) => requestAnimationFrame(cb)
          : (cb) => setTimeout(cb, 16) as unknown as number;
      const cancelRaf = (h: number) => {
        if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(h);
        else clearTimeout(h as unknown as ReturnType<typeof setTimeout>);
      };
      const flushDelta = () => {
        if (flushHandle !== null) { cancelRaf(flushHandle as number); flushHandle = null; }
        if (deltaBuffer) {
          const buffered = deltaBuffer;
          deltaBuffer = null;
          get().addActivity({ type: "stream_delta", from: buffered.from, body: buffered.body, ts: buffered.ts } as ActivityEntry);
        }
      };
      const scheduleFlush = () => {
        if (flushHandle === null) {
          flushHandle = raf(() => { flushHandle = null; flushDelta(); });
        }
      };

      sseClient.on((entry) => {
        set({ isConnected: sseClient.isConnected, connectionStatus: "live" });

        // Fast path: buffer stream_delta, defer the heavy store update.
        if (entry.type === "stream_delta" && entry.from) {
          if (deltaBuffer && deltaBuffer.from !== entry.from) flushDelta();
          if (!deltaBuffer) deltaBuffer = { from: entry.from, body: "", ts: entry.ts };
          deltaBuffer.body += entry.body ?? "";
          scheduleFlush();
          return;
        }

        // Any non-delta event: flush pending deltas first to preserve ordering.
        flushDelta();
        get().addActivity(entry);

        // Handle phase events for loop phase transitions
        if (entry.type === "phase") {
          const p = entry.phase ?? "";

          // ── Single authority: the backend SwarmStateMachine emits an
          // authoritative `phase` event for every LoopPhase transition. The
          // frontend is a PURE PROJECTION — adopt any authoritative phase
          // directly, with no local inference. Non-LoopPhase phase events
          // (workers / cloner-review / todo-updated / etc.) are sub-events
          // handled by their own side-effects below.
          if (AUTHORITATIVE_LOOP_PHASES.has(p)) {
            const phase = p as LoopPhase;
            set((s) => ({
              loopPhase: phase,
              // blockerContext is only meaningful while blocked; clear it on
              // any transition away from "blocked".
              blockerContext: phase === "blocked" ? s.blockerContext : null,
            }));
            if (phase === "blocked") {
              toast.warning("Swarm Blocked", { description: "The swarm has encountered a blocker and is waiting for your decision." });
            }
          }

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

        // Stream ended from Socrates during before-loop — unlock the input
        // immediately instead of waiting for the next phase event.
        if (entry.type === "stream_end" && entry.from === "socrates" && get().loopPhase.startsWith("before-loop")) {
          get().refreshBeforeLoopState();
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

      // ── Stream start: create an empty streaming bubble in roundtable ──
      // During history replay, skip — the downstream stream_end event (handled
      // below) will create the finalised message with the complete body.
      if (entry.type === "stream_start" && entry.from) {
        if (fromHistory) return { activities, channels, messages };
        const msgId = (entry as any).messageId ?? entry.from;
        const msgList = [...(messages.get("roundtable") ?? [])];
        msgList.push({
          id: `stream-${String(msgId)}`,
          channelId: "roundtable",
          from: entry.from,
          to: "all",
          body: "",
          streaming: true as const,
          timestamp: entry.ts,
        } as ChatMessage);
        messages.set("roundtable", msgList);
        return { activities, channels, messages };
      }

      // ── Streaming delta: append to the last streaming bubble ──
      // During history replay (fromHistory), skip stream_delta — the
      // downstream broadcast event already carries the full message body.
      if (entry.type === "stream_delta" && entry.from) {
        // During history replay, skip stream_delta — the downstream broadcast
        // event already carries the full message body (see stream_start note above).
        if (fromHistory) return { activities, channels, messages };
        const msgId = (entry as any).messageId ?? entry.from;
        const msgList = [...(messages.get("roundtable") ?? [])];
        const lastMsg = msgList[msgList.length - 1];
        if (lastMsg && lastMsg.id.startsWith(`stream-`)) {
          // Replace with a new object so React.memo detects the prop change
          msgList[msgList.length - 1] = {
            ...lastMsg,
            body: lastMsg.body + (entry.body ?? ""),
          };
        } else {
          msgList.push({
            id: `stream-${String(msgId)}`,
            channelId: "roundtable",
            from: entry.from,
            to: "all",
            body: entry.body ?? "",
            streaming: true as const,
            timestamp: entry.ts,
          } as ChatMessage);
        }
        messages.set("roundtable", msgList);
        return { activities, channels, messages };
      }

      // ── Stream end: finalise the streaming bubble ──
      // During history replay: a stream_end carries the completed body and
      // optional thinking. Broadcast messages capture IRC-style messages,
      // NOT the full stream output, so we must create the stream message
      // from the stream_end finalBody. Do NOT blindly attach thinking to a
      // broadcast — the broadcast may have a different (summary) body.
      if (entry.type === "stream_end" && entry.from) {
        const msgId = (entry as any).messageId ?? entry.from;
        const streamBubbleId = `stream-${String(msgId)}`;

        if (fromHistory) {
          const msgList = [...(messages.get("roundtable") ?? [])];
          // Case A: stream_end carries a completed body — create a stream
          // bubble (stream_start/delta are skipped during replay, so only
          // stream_end can restore the full message).
          if (entry.body) {
            const exists = msgList.some(
              (m) => m.id === streamBubbleId || (m.from === entry.from && m.id.startsWith("stream-")),
            );
            if (!exists) {
              msgList.push({
                id: streamBubbleId,
                channelId: "roundtable",
                from: entry.from,
                to: "all",
                body: entry.body,
                thinking: entry.thinking,
                streaming: false as const,
                timestamp: entry.ts,
              } as ChatMessage);
              messages.set("roundtable", msgList);
            }
            return { activities, channels, messages };
          }
          // Case B: stream_end has thinking but NO body (legacy log format).
          // Attach thinking to the most recent non-stream message from the
          // same source.
          if (entry.thinking) {
            for (let i = msgList.length - 1; i >= 0; i--) {
              if (msgList[i].from === entry.from && !msgList[i].id.startsWith("stream-")) {
                msgList[i] = { ...msgList[i], thinking: entry.thinking };
                messages.set("roundtable", msgList);
                break;
              }
            }
          }
          return { activities, channels, messages };
        }

        // Live: prefer delta-accumulated body over stream_end body when the
        // accumulated text is longer (deltas arrive token-by-token and are
        // the definitive content; stream_end body can be truncated/malformed
        // from a race in the backend stream accumulator).
        const msgList = [...(messages.get("roundtable") ?? [])];
        const lastMsg = msgList[msgList.length - 1];
        if (lastMsg && lastMsg.id.startsWith("stream-")) {
          const finalBody =
            lastMsg.body && lastMsg.body.length > (entry.body?.length ?? 0)
              ? lastMsg.body
              : (entry.body || lastMsg.body);
          msgList[msgList.length - 1] = {
            ...lastMsg,
            body: finalBody,
            thinking: entry.thinking || (lastMsg as any).thinking,
            streaming: false as const,
          };
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
      // Backend is the single authority for loopPhase (StateTracker.state.loopPhase
      // is set atomically by the SwarmStateMachine). Polling adopts it directly —
      // the previous "keep blocked" guard is no longer needed because the backend
      // holds "blocked" until the blocker is resolved, so the polled value already
      // reflects it. Only fall back to a derived phase when the backend has none.
      const polledPhase = state?.loopPhase ?? (nowRunning ? "running" : "idle");

      set({
        // Guard against null API response — a brand-new session may not
        // have swarm state yet, which would overwrite our minimal idle state
        // and cause the right panel (ContextPanel) to disappear.
        swarmState: state || get().swarmState,
        isRunning: nowRunning,
        loopPhase: polledPhase,
        todos: state?.todos ?? [],
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
