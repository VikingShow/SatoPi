/**
 * Swarm store — real-time swarm state + SSE event buffer.
 *
 * Maintains the current SwarmState (polled via REST) and a ring buffer
 * of recent ActivityEntry events (pushed via SSE). Also manages the
 * chat channel list derived from activity events.
 */

import { create } from "zustand";
import { toast } from "sonner";
import type { SwarmState, ActivityEntry, ChatChannel, ChatMessage, CurtainResult, Chapter, ScriptState, TodoItem, BlockerContext, BlockerResolution } from "../lib/types";
import { api, setActiveSession } from "../lib/api-client";
import { sseClient, setActiveSSESession } from "../lib/sse-client";
import { deriveChannel } from "../lib/channel-derivation";
import { useSessionStore } from "./session-store";

const MAX_ACTIVITIES = 500;
const MAX_FILE_CHANGES = 500;
const MAX_TOOL_CALLS_PER_AGENT = 200;

// -- Agent / pipeline state event apply helpers --------------------------
// Extracted so the live-SSE handler and the history-replay handler share
// the same logic — no drift between the two code paths.

function applyAgentStateEntry(
	entry: ActivityEntry,
	agents: Record<string, NonNullable<SwarmState["agents"]>[string]> | undefined,
): Record<string, NonNullable<SwarmState["agents"]>[string]> | null {
	if (!agents) return null;
	const existing = agents[entry.agent!];
	if (!existing) return null;
	const updated = { ...existing };
	const e = entry as unknown as Record<string, unknown>;
	if (e.status !== undefined) updated.status = e.status as NonNullable<SwarmState["agents"]>[string]["status"];
	if (e.iteration !== undefined) updated.iteration = e.iteration as number;
	if (e.praiseCount !== undefined) updated.praiseCount = e.praiseCount as number;
	if (e.criticismCount !== undefined) updated.criticismCount = e.criticismCount as number;
	if (e.conflictCount !== undefined) updated.conflictCount = e.conflictCount as number;
	if (e.role !== undefined) updated.role = e.role as typeof updated.role;
	if (e.modelName !== undefined) updated.modelName = e.modelName as string;
	const next = { ...agents };
	next[entry.agent!] = updated;
	return next;
}

function applyPipelineStateEntry(
	entry: ActivityEntry,
	swarmState: SwarmState | null,
): SwarmState | null {
	if (!swarmState) return null;
	const e = entry as unknown as Record<string, unknown>;
	const patch: Partial<SwarmState> = {};
	if (e.loopIteration !== undefined) patch.loopIteration = e.loopIteration as number;
	if (e.roundtablePhase !== undefined) patch.roundtablePhase = e.roundtablePhase as string;
	if (e.todos !== undefined) patch.todos = e.todos as SwarmState["todos"];
	if (e.totalTokens !== undefined) patch.totalTokens = e.totalTokens as number;
	if (e.totalRequests !== undefined) patch.totalRequests = e.totalRequests as number;
	if (Object.keys(patch).length === 0) return null;
	return { ...swarmState, ...patch };
}

/**
 * The set of Chapter values the backend SwarmStateMachine broadcasts as
 * authoritative phase events. The frontend adopts these verbatim (pure
 * projection). Other `phase` events (workers/agent-review/todo-updated/…)
 * are sub-events and must NOT be treated as a Chapter.
 */
const AUTHORITATIVE_LOOP_PHASES = new Set<string>([
  "idle",
  "script",
  "script-debate",
  "script-confirm",
  "stage",
  "paused",
  "blocked",
  "curtain",
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
  phase: Chapter;
  scriptState: ScriptState | null;
  planVersion: number;
  todos: TodoItem[];
  curtainResult: CurtainResult | null;
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
  fetchCurtainResult: () => Promise<void>;

  // Pause / Resume
  pauseRun: () => Promise<void>;
  resumeRun: () => Promise<void>;

  // Script actions
  startPlanning: (task: string, agentId?: string) => Promise<void>;
  sendScriptMessage: (text: string) => Promise<void>;
  runDebate: () => Promise<void>;
  confirmAndStart: () => Promise<void>;
  cancelScript: () => Promise<void>;
  refreshScriptState: () => Promise<void>;
  /** P2-2: Load script conversation history. */
  loadScriptHistory: () => Promise<Array<{ role: string; content: string }>>;

  // Steering (during running loop)
  sendSteering: (text: string) => Promise<void>;

  // Blocker resolution
  resolveBlocker: (decision: BlockerResolution) => Promise<void>;

  /**
   * Switch the swarm store to a different session.
   *
   * Encapsulates the full lifecycle: SSE listener cleanup, state reset,
   * history replay, and initial state fetch.  The `mode` parameter
   * determines whether the store connects to SSE ('live') or replays
   * a historical activity log read-only ('historical').
   */
  switchToSession: (name: string, mode: 'live' | 'historical') => Promise<void>;
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
      from: "human",
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

/**
 * Wait for the SSE client to reach OPEN state, with a configurable timeout.
 *
 * Without this guard, the user can click "Send" before the EventSource
 * handshake completes — the backend then broadcasts events into an
 * EventBus with no subscriber, and every event is silently lost.
 * The history replay on page-refresh eventually recovers them, giving
 * the appearance of "no real-time updates but refresh works."
 */
async function waitForSSE(sse: typeof sseClient, timeoutMs: number): Promise<void> {
	if (sse.isConnected) return;
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve) => {
		const unsub = sse.onConnectionChange((connected) => {
			if (connected || Date.now() >= deadline) {
				unsub();
				resolve();
			}
		});
		// Safety net: resolve on deadline even if never connected.
		setTimeout(() => { unsub(); resolve(); }, timeoutMs);
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
  phase: "idle",
  scriptState: null,
  planVersion: 0,
  todos: [],
  curtainResult: null,
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

      // Seed isConnected / connectionStatus from the SSE client's current state.
      // If session-store subscribe already connected before onConnChange was
      // registered (persist hydration race), we'll miss the initial onopen —
      // so we must read isConnected here.  Crucially, do NOT set hasConnectedOnce
      // here: it must be managed exclusively by onConnChange so that the first
      // genuine connect AFTER listener registration is never treated as a
      // "reconnect" and does not fire the "Reconnected" toast.  Once onConnChange
      // fires (true), it bumps hasConnectedOnce to true and subsequent
      // disconnect→reconnect cycles will toast correctly.
      if (sseClient.isConnected) {
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
        // received one. phase is also read defensively via optional chaining.
        set((prev) => ({
          swarmState: state ?? prev.swarmState,
          isRunning: runStatus.running,
          phase: state?.phase ?? (runStatus.running ? "stage" : "idle"),
          error: null,
        }));
      } catch (apiErr: any) {
        const msg = String(apiErr?.message ?? apiErr);
        // If the stored session does not exist on the backend (stale from
        // backend restart, or request routed to a different backend instance),
        // fall back to the default "SatoPi" session WITHOUT deleting the
        // historical session from disk.  Calling deleteSession here would
        // permanently destroy the .swarm_{name}/ directory — the session
        // survives the backend restart on disk and can be recovered once
        // the backend scans its workspace again.
        if (msg.includes("not found") || msg.includes("404")) {
          const { useSessionStore } = await import("./session-store");
          const { setActiveSession } = await import("../lib/api-client");
          const { setActiveSSESession } = await import("../lib/sse-client");
          const staleName = useSessionStore.getState().activeSwarm;
          // Clean up only the frontend-local state (runs list, activeSwarm).
          // Do NOT call deleteSession — that would invoke DELETE /api/sessions
          // and remove the .swarm_{name} directory from disk.
          useSessionStore.setState((s) => ({
            activeSwarm: "SatoPi",
            viewingSession: null,
            runs: s.runs.filter((r) => r.name !== staleName),
          }));
          const fallback = "SatoPi";
          setActiveSession(fallback);
          setActiveSSESession(fallback);
          set({ phase: "idle", isRunning: false, error: null });
          // Re-init with the fallback session.
          (get() as any).__initRunning = false;
          get().init();
          return;
        }
        set({ error: msg });
      }

      // Fetch script state if in a script phase
      const phase = get().phase;
      if (phase.startsWith("script")) {
        try {
          const blState = await api.getScriptState();
          set({ scriptState: blState });
          // Conversation history is NOT loaded separately — the activity log
          // replay below (api.getHistory → addActivity) already carries every
          // broadcast event (operator + socrates messages) from session.jsonl.
          // Loading conversation turns in parallel would create duplicate
          // ChatMessages with different IDs, doubling every message in chat.
        } catch {
          // might not be available
        }
      }

      // Fetch any existing curtain result from a previous run
      try {
        const afterLoop = await api.getCurtainSummary();
        set({ curtainResult: afterLoop });
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
        // Prevent a full Zustand equality check + selector re-eval on every
        // token-level stream_delta (20-30/s).  onConnectionChange is the
        // canonical authority for connection state; this catch-up guard runs
        // only when a preceding onConnectionChange(true) was missed.
        if (!get().isConnected) {
          set({ isConnected: true, connectionStatus: "live" });
        }

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
          // authoritative `phase` event for every Chapter transition. The
          // frontend is a PURE PROJECTION — adopt any authoritative phase
          // directly, with no local inference. Non-Chapter phase events
          // (workers / agent-review / todo-updated / etc.) are sub-events
          // handled by their own side-effects below.
          if (AUTHORITATIVE_LOOP_PHASES.has(p)) {
            const phase = p as Chapter;
            set((s) => ({
              phase: phase,
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
          if (p === "curtain-done") {
            setTimeout(() => get().fetchCurtainResult(), 500);
          }

          // Refresh script state on relevant phase events
          if (p.startsWith("script") || p === "debate-start" || p === "debate-done") {
            setTimeout(() => get().refreshScriptState(), 300);
          }
        }

        // Broadcast messages in script: also refresh script state
        // (to detect planReady changes)
        if (entry.type === "broadcast" && entry.from === "planner") {
          setTimeout(() => get().refreshScriptState(), 300);
        }

        // Stream ended from Socrates during script — unlock the input
        // immediately instead of waiting for the next phase event.
        if (entry.type === "stream_end" && entry.from === "planner" && get().phase.startsWith("script")) {
          get().refreshScriptState();
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
          toast.success(`Steering delivered to ${entry.acknowledgedBy ?? "agent"}`, { duration: 2000 });
        }

        // P2-10: Tool call — show in-line tool execution indicator.
        if (entry.type === "tool_call" && entry.toolName) {
          // Tool calls are captured via addActivity → deriveChannel for chat display.
          // The toast provides a transient notification for long-running tools.
          if (entry.toolDurationMs && entry.toolDurationMs > 3000) {
            toast(`${entry.agent ?? "agent"}: ${entry.toolName} (${(entry.toolDurationMs / 1000).toFixed(1)}s)`, {
              description: entry.toolError ? `Error: ${entry.toolError}` : entry.toolOutput?.slice(0, 200),
              duration: 3000,
            });
          }

          // Populate toolCalls for AgentTimeline
          set((s) => {
            const toolCalls = new Map(s.toolCalls);
            const agent = entry.agent ?? entry.from ?? "unknown";
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
            // Per-agent cap — AgentTimeline only shows recent calls
            if (agentCalls.length > MAX_TOOL_CALLS_PER_AGENT) {
              agentCalls.splice(0, agentCalls.length - MAX_TOOL_CALLS_PER_AGENT);
            }
            toolCalls.set(agent, agentCalls);
            return { toolCalls };
          });
        }

        // Track file_change events for FileChangesPanel (capped)
        if (entry.type === "file_change" && entry.file) {
          set((s) => ({
            fileChanges: [...s.fileChanges, {
              ts: entry.ts,
              agent: entry.agent ?? entry.from ?? "unknown",
              file: entry.file!,
              action: entry.action ?? "modified",
              linesChanged: entry.linesChanged,
            }].slice(-MAX_FILE_CHANGES),
          }));
        }

        // P1-1: Real-time agent state — update swarmState.agents without polling.
        if (entry.type === "agent_state" && entry.agent) {
          set((s) => {
            const agents = applyAgentStateEntry(entry, s.swarmState?.agents);
            if (!agents) return {};
            return { swarmState: { ...s.swarmState!, agents } };
          });
        }

        // P1-1: Real-time pipeline state — merge loopIteration etc. without polling.
        if (entry.type === "pipeline_state") {
          set((s) => {
            const next = applyPipelineStateEntry(entry, s.swarmState);
            if (!next) return {};
            return { swarmState: next };
          });
        }
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

      // Poll state + run status every 5s.
      // Pause polling when the tab is hidden to avoid wasted requests;
      // SSE stays alive in the background to accumulate events.
      let pollHandle: ReturnType<typeof setInterval> | null = null;
      function startPolling() {
        if (pollHandle !== null) return;
        pollHandle = setInterval(() => get().refreshState(), 5000);
      }
      function stopPolling() {
        if (pollHandle !== null) { clearInterval(pollHandle); pollHandle = null; }
      }
      startPolling();
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", () => {
          if (document.hidden) {
            stopPolling();
          } else {
            get().refreshState(); // immediate refresh on return
            startPolling();
          }
        });
      }
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
      // Across both live and history replay, create the placeholder bubble.
      // During replay the downstream stream_delta events accumulate text,
      // and stream_end finalises it.  Previously history replay skipped
      // stream_start (which meant stream_end had nothing to finalise into,
      // exposing parseSocratesResponse's JSON fallback body).
      if (entry.type === "stream_start" && entry.from) {
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
      // During history replay the deltas accumulate just like live so
      // the stream_end handler can prefer the accumulated (natural-language)
      // body over the finalBody that may have been post-processed (e.g.
      // parseSocratesResponse strip-JSON output).
      if (entry.type === "stream_delta" && entry.from) {
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
          // Look for an existing stream bubble (created by stream_start
          // and populated by stream_delta during replay).
          const existingIdx = msgList.findIndex(
            (m) => m.id === streamBubbleId || (m.from === entry.from && m.id.startsWith("stream-")),
          );

          if (existingIdx >= 0) {
            // Prefer delta-accumulated body when it is longer — same as the
            // live path.  stream_end body may come from a post-processor
            // (e.g. parseSocratesResponse) that strips natural language in
            // favour of a JSON-derived fallback.
            const accumulated = msgList[existingIdx];
            const finalBody =
              accumulated.body && accumulated.body.length > (entry.body?.length ?? 0)
                ? accumulated.body
                : (entry.body || accumulated.body);
            msgList[existingIdx] = {
              ...accumulated,
              body: finalBody,
              thinking: entry.thinking || (accumulated as any).thinking,
              streaming: false as const,
            };
            messages.set("roundtable", msgList);
            return { activities, channels, messages };
          }

          // No existing stream bubble — create from stream_end body.
          if (entry.body) {
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
            return { activities, channels, messages };
          }

          // stream_end has thinking but NO body (legacy log format).
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
        const isHumanEcho = !fromHistory &&
          (entry.type === "broadcast" || entry.type === "steering") &&
          entry.from === "human";

        const existing = channels.get(derived.id);
        if (!existing) {
          channels.set(derived.id, derived.channel);
        } else {
          existing.lastMessage = derived.channel.lastMessage;
          existing.lastMessageTime = derived.channel.lastMessageTime;
          if (state.activeChannelId !== derived.id) existing.unreadCount++;
        }

        if (!isHumanEcho) {
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
      // Backend is the single authority for phase (StateTracker.state.phase
      // is set atomically by the SwarmStateMachine). Polling adopts it directly —
      // the previous "keep blocked" guard is no longer needed because the backend
      // holds "blocked" until the blocker is resolved, so the polled value already
      // reflects it. Only fall back to a derived phase when the backend has none.
      const polledPhase = state?.phase ?? (nowRunning ? "stage" : "idle");

      set({
        // Guard against null API response — a brand-new session may not
        // have swarm state yet, which would overwrite our minimal idle state
        // and cause the right panel (ContextPanel) to disappear.
        swarmState: state || get().swarmState,
        isRunning: nowRunning,
        phase: polledPhase,
        todos: state?.todos ?? [],
        error: null,
      });

      // When a run transitions from running → stopped, fetch curtain result
      if (wasRunning && !nowRunning) {
        // Small delay to let the curtain pipeline finish writing
        setTimeout(() => get().fetchCurtainResult(), 1000);
      }
    } catch (err) {
      set({ error: String(err) });
    }
  },

  startRun: async () => {
    try {
      const result = await api.startRun();
      if (result.success) {
        set({ isRunning: true, phase: "stage", curtainResult: null, error: null });
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

  fetchCurtainResult: async () => {
    try {
      const result = await api.getCurtainSummary();
      // Stay in "curtain" phase — user must click Applaud to transition to idle
      set({ curtainResult: result });
    } catch {
      // 404 is expected when no curtain result is available
    }
  },

  // ── Pause / Resume ──

  pauseRun: async () => {
    try {
      const result = await api.pauseRun();
      if (result.success) {
        set({ phase: "paused" });
        toast.info("Swarm Paused", { description: "Agents have been paused. Click Resume to continue." });
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
        set({ phase: "stage" });
        toast.success("Swarm Resumed", { description: "Agents are continuing." });
      } else {
        toast.error("Failed to resume", { description: result.error ?? "Unknown error" });
      }
    } catch (err) {
      toast.error("Failed to resume", { description: String(err) });
    }
  },

  // ── Before Loop actions ──

  startPlanning: async (task: string, agentId?: string) => {
    pushUserMessage(set, task);
    await waitForSSE(sseClient, 2000);
    try {
      const result = await api.startScript(task, agentId);
      if (result.success) {
        set({ phase: "script", error: null });
        set({ activeChannelId: "roundtable" });
        setTimeout(() => get().refreshScriptState(), 500);
      } else {
        set({ error: result.error ?? "Failed to start planning" });
      }
    } catch (err) {
      set({ error: String(err) });
    }
  },

  sendScriptMessage: async (text: string) => {
    // Optimistically add user's message to chat for instant display
    pushUserMessage(set, text);
    await waitForSSE(sseClient, 2000);
    try {
      const result = await api.sendScriptMessage(text);
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
        set({ phase: "script-debate", error: null });
      } else {
        set({ error: result.error ?? "Failed to start debate" });
      }
    } catch (err) {
      set({ error: String(err) });
    }
  },

  confirmAndStart: async (opts?: { agentCount?: number; reviewerCount?: number }) => {
    try {
      const result = await api.confirmScript(opts);
      if (result.success) {
        set({ phase: "stage", isRunning: true, curtainResult: null, error: null });
      } else {
        set({ error: result.error ?? "Failed to confirm" });
      }
    } catch (err) {
      set({ error: String(err) });
    }
  },

  cancelScript: async () => {
    try {
      const result = await api.cancelScript();
      if (result.success) {
        set({ phase: "idle", scriptState: null, error: null });
      } else {
        set({ error: result.error ?? "Failed to cancel" });
      }
    } catch (err) {
      set({ error: String(err) });
    }
  },

  refreshScriptState: async () => {
    try {
      const blState = await api.getScriptState();
      set({ scriptState: blState, phase: blState.phase });

      // If debate finished, update phase
      if (blState.phase === "script-confirm") {
        set({ phase: "script-confirm" });
      }
    } catch {
      // Before-loop manager might not be available
    }
  },

  // P2-2: Load script conversation history.
  loadScriptHistory: async () => {
    try {
      const result = await api.loadScriptHistory();
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
        set({ blockerContext: null, phase: decision === "abort" ? "idle" : "stage", error: null });
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

  // ── Session lifecycle ──

  /**
   * Switch the swarm store to a different session.
   *
   * This is the single entry-point for all session transitions — new
   * session creation, switching to a historical read-only view, and
   * returning to the live session.  It replaces the previous pattern of
   * useSwarmStore.setState({…15 fields…}) + (as any).__initRunning hacks
   * scattered across session-store.ts.
   *
   * SSE listener lifecycle is managed internally: we track the
   * unsubscribe handle returned by sseClient.on() and tear it down
   * before creating a new one, eliminating the listener-accumulation
   * bug that caused duplicate messages on repeated init() calls.
   */
  switchToSession: async (name: string, mode) => {
    // 1. Tear down the existing SSE event listener so it never
    //    accumulates (old init() pattern leaked one callback per call).
    const oldUnsub = (get() as any).__sseUnsubscribe as (() => void) | undefined;
    if (oldUnsub) { oldUnsub(); (get() as any).__sseUnsubscribe = undefined; }

    // 2. Reset in-memory state to a clean slate.
    // ContextPanel guards on swarmState null, so provide a minimal idle
    // state so the panel shell stays visible.
    set({
      swarmState: { name, status: "idle", mode: "loop", iteration: 0, targetCount: 0, agents: {}, startedAt: Date.now() },
      activities: [],
      channels: new Map(),
      messages: new Map(),
      activeChannelId: "roundtable",
      isRunning: false,
      phase: "idle",
      scriptState: null,
      planVersion: 0,
      todos: [],
      curtainResult: null,
      blockerContext: null,
      error: null,
      convergenceHistory: [],
      toolCalls: new Map(),
      fileChanges: [],
    });

    if (mode === 'historical') {
      // Read-only: skip SSE, just load and replay the activity log.
      try {
        const { entries } = await api.getRunActivity(name);
        for (const entry of (entries as ActivityEntry[])) {
          get().addActivity(entry, true);
        }
      } catch { /* activity log may not be available */ }
      return;
    }

    // 3. 'live' mode — connect SSE, fetch state, replay history.
    setActiveSSESession(name);

    // Register the SSE event handler through the same closure that init() uses.
    // We re-create the complete SSE pipeline here rather than calling init()
    // because init() has a __initRunning guard that would block re-entry.
    //
    // Stream-delta batching (RAF coalesce), phase-event dispatching, tool-call
    // tracking, file-change tracking, convergence tracking, and error-flag
    // handling are all self-contained in the on() callback — we're registering
    // a fresh closure that references the live store via get()/set().
    //
    // The unsubscription handle is tracked so future switchToSession() calls
    // clean it up (step 1 above).
    {
      // ── stream_delta batching (same RAF coalesce as init()) ──
      let deltaBuffer: { from: string; body: string; ts: number } | null = null;
      let flushHandle: ReturnType<typeof setTimeout> | number | null = null;
      const raf: (cb: () => void) => number =
        typeof requestAnimationFrame !== "undefined"
          ? (cb) => requestAnimationFrame(cb)
          : (cb) => setTimeout(cb, 16) as unknown as number;
      const cancelRaf = (h: number) => {
        if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(h as number);
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

      const handler = (entry: ActivityEntry) => {
        if (!get().isConnected) {
          set({ isConnected: true, connectionStatus: "live" });
        }

        if (entry.type === "stream_delta" && entry.from) {
          if (deltaBuffer && deltaBuffer.from !== entry.from) flushDelta();
          if (!deltaBuffer) deltaBuffer = { from: entry.from, body: "", ts: entry.ts };
          deltaBuffer.body += entry.body ?? "";
          scheduleFlush();
          return;
        }

        flushDelta();
        get().addActivity(entry);

        // Phase transitions (authoritative from SwarmStateMachine)
        if (entry.type === "phase") {
          const p = entry.phase ?? "";
          if (AUTHORITATIVE_LOOP_PHASES.has(p)) {
            const phase = p as Chapter;
            set((s) => ({
              phase: phase,
              blockerContext: phase === "blocked" ? s.blockerContext : null,
            }));
            if (phase === "blocked") {
              toast.warning("Swarm Blocked", { description: "The swarm has encountered a blocker and is waiting for your decision." });
            }
          }
          if (p === "plan-updated") set((s) => ({ planVersion: s.planVersion + 1 }));
          if (p === "todo-updated") setTimeout(() => get().refreshState(), 100);
          if (p === "curtain-done") setTimeout(() => get().fetchCurtainResult(), 500);
          if (p.startsWith("script") || p === "debate-start" || p === "debate-done") {
            setTimeout(() => get().refreshScriptState(), 300);
          }
        }

        if (entry.type === "broadcast" && entry.from === "planner") {
          setTimeout(() => get().refreshScriptState(), 300);
        }

        if (entry.type === "stream_end" && entry.from === "planner" && get().phase.startsWith("script")) {
          get().refreshScriptState();
        }

        if (entry.type === "convergence" && entry.jaccard !== undefined) {
          set((s) => ({
            convergenceHistory: [
              ...s.convergenceHistory,
              { ts: entry.ts, jaccard: entry.jaccard!, converged: entry.converged ?? false },
            ].slice(-20),
          }));
        }

        if (entry.type === "steering_ack") {
          toast.success(`Steering delivered to ${entry.acknowledgedBy ?? "agent"}`, { duration: 2000 });
        }

        if (entry.type === "tool_call" && entry.toolName) {
          if (entry.toolDurationMs && entry.toolDurationMs > 3000) {
            toast(`${entry.agent ?? "agent"}: ${entry.toolName} (${(entry.toolDurationMs / 1000).toFixed(1)}s)`, {
              description: entry.toolError ? `Error: ${entry.toolError}` : entry.toolOutput?.slice(0, 200),
              duration: 3000,
            });
          }
          set((s) => {
            const toolCalls = new Map(s.toolCalls);
            const agent = entry.agent ?? entry.from ?? "unknown";
            const agentCalls = [...(toolCalls.get(agent) ?? [])];
            const call = {
              ts: entry.ts,
              tool: entry.toolName,
              duration: entry.toolDurationMs ?? undefined,
              exitCode: (entry.toolError ? 1 : 0) as number | undefined,
            } as { ts: number; tool: string; file?: string; duration?: number; tokens?: number; exitCode?: number };
            if (entry.file) call.file = entry.file;
            agentCalls.push(call);
            if (agentCalls.length > MAX_TOOL_CALLS_PER_AGENT) {
              agentCalls.splice(0, agentCalls.length - MAX_TOOL_CALLS_PER_AGENT);
            }
            toolCalls.set(agent, agentCalls);
            return { toolCalls };
          });
        }

        if (entry.type === "file_change" && entry.file) {
          set((s) => ({
            fileChanges: [...s.fileChanges, {
              ts: entry.ts,
              agent: entry.agent ?? entry.from ?? "unknown",
              file: entry.file!,
              action: entry.action ?? "modified",
              linesChanged: entry.linesChanged,
            }].slice(-MAX_FILE_CHANGES),
          }));
        }

        if (entry.type === "agent_state" && entry.agent) {
          set((s) => {
            const agents = applyAgentStateEntry(entry, s.swarmState?.agents);
            if (!agents) return {};
            return { swarmState: { ...s.swarmState!, agents } };
          });
        }

        if (entry.type === "pipeline_state") {
          set((s) => {
            const next = applyPipelineStateEntry(entry, s.swarmState);
            if (!next) return {};
            return { swarmState: next };
          });
        }

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

        if (entry.type === "broadcast" && entry.from === "system" && entry.body) {
          try {
            const parsed = JSON.parse(entry.body);
            if (parsed?.type === "blocker" && parsed?.context) {
              set({ blockerContext: parsed.context as BlockerContext });
              toast.error("Blocker Detected", { description: (parsed.context as BlockerContext)?.reason ?? "A blocker requires your attention" });
            }
          } catch { /* not a blocker message */ }
        }
      };

      (get() as any).__sseUnsubscribe = sseClient.on(handler);
    }

    // 4. Fetch initial state (async, non-blocking for the caller).
    try {
      const [state, runStatus] = await Promise.all([
        api.getState(),
        api.getRunStatus(),
      ]);
      set((prev) => ({
        swarmState: state ?? prev.swarmState,
        isRunning: runStatus.running,
        phase: state?.phase ?? (runStatus.running ? "stage" : "idle"),
        error: null,
      }));
    } catch { /* brand-new session may not have state yet */ }

    // 5. Fetch script / curtain state if applicable.
    const phase = get().phase;
    if (phase.startsWith("script")) {
      try { set({ scriptState: await api.getScriptState() }); } catch {}
    }
    try { set({ curtainResult: await api.getCurtainSummary() }); } catch {}

    // 6. Replay history.
    try {
      const { entries } = await api.getHistory();
      for (const entry of (entries as ActivityEntry[])) {
        get().addActivity(entry, true);
      }
    } catch { /* history may not be available */ }
  },
}));
