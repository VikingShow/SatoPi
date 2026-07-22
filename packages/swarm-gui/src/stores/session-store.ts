/**
 * Session store — manages swarm run sessions.
 *
 * A "session" is a single swarm run lifecycle:
 *   before-loop → running → after-loop
 *
 * A "historical session" is a `.swarm_<name>/` directory in the workspace
 * that contains persisted activity logs and state from a previous run.
 * The session switcher in the sidebar lets the user view these in
 * read-only mode without disturbing the active run.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api, setActiveSession } from "../lib/api-client";
import { setActiveSSESession } from "../lib/sse-client";
import type { ActivityEntry } from "../lib/types";
import { useSwarmStore } from "./swarm-store";

async function toastOnce(message: string, opts?: { description?: string }) {
  const { toast } = await import("sonner");
  toast.error(message, { id: "session-error", ...opts });
}

export interface RunMeta {
  name: string;
  dir: string;
  lastActivity: string | null;
  messageCount: number;
  status: "idle" | "running" | "completed" | "failed";
}

interface SessionStore {
  /** Name of the currently active swarm (matches swarmState.name) */
  activeSwarm: string;
  /** Name of the session being viewed (may differ from activeSwarm in read-only mode) */
  viewingSession: string | null;
  runs: RunMeta[];

  loadRuns: () => Promise<void>;
  newSession: () => Promise<string | null>;
  /** Delete a session on the backend and remove it from the local list. */
  deleteSession: (name: string) => Promise<void>;
  switchToSession: (name: string) => Promise<void>;
  backToCurrent: () => void;
}

function generateSwarmName(): string {
  // New sessions get a unique name so they don't collide with existing swarms
  const ts = new Date();
  const yyyymmdd = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, "0")}${String(ts.getDate()).padStart(2, "0")}`;
  const hhmm = `${String(ts.getHours()).padStart(2, "0")}${String(ts.getMinutes()).padStart(2, "0")}`;
  return `SatoPi-${yyyymmdd}-${hhmm}`;
}

export const useSessionStore = create<SessionStore>()(
  persist(
    (set, get) => ({
      activeSwarm: "SatoPi",
      viewingSession: null,
      runs: [],

  loadRuns: async () => {
    try {
      const data = await api.getRuns();
      set({ runs: data.runs });
    } catch {
      // Runs API might not return results
    }
  },

  deleteSession: async (name: string) => {
    try {
      await api.deleteSession(name);
    } catch (err: any) {
      toastOnce(`Failed to delete session: ${err?.message ?? String(err)}`);
      return;
    }
    // Remove from local runs list.
    const { runs, activeSwarm } = get();
    const nextRuns = runs.filter((r) => r.name !== name);
    let nextActive = activeSwarm;
    let nextViewing = get().viewingSession;
    // If the deleted session was the active one, fall back to the first
    // remaining session (or "SatoPi" if none).
    if (activeSwarm === name || nextViewing === name) {
      nextActive = nextRuns.length > 0 ? nextRuns[0]!.name : "SatoPi";
      nextViewing = null;
      // Switch the api/sse clients to the fallback session.
      setActiveSession(nextActive);
      // switchToSession handles SSE lifecycle + state reset internally.
      useSwarmStore.getState().switchToSession(nextActive, "live");
    }
    set({ runs: nextRuns, activeSwarm: nextActive, viewingSession: nextViewing });
    import("sonner").then(({ toast }) => toast.success(`Deleted session “${name}”`));
  },

  newSession: async () => {
    // Cancel any active before-loop — ignore failures (none may be active).
    try { await api.cancelBeforeLoop(); } catch {}
    // Stop any running swarm — ignore "No run in progress" errors.
    try { await api.stopRun(); } catch {}

    // Generate a new unique name (visible to the user immediately)
    const newName = generateSwarmName();

    // Create the session on the backend. This is the gate: if it fails (e.g.
    // session limit reached, backend error), we must NOT proceed — switching
    // to a non-existent session would cause every subsequent API call to 404.
    try {
      await api.createSession(newName);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // Dedup toast via id — avoids stacking when retried quickly.
      if (msg.includes("Max 3 concurrent")) {
        toastOnce("Session limit reached", { description: "Max 3 concurrent sessions. Delete old ones in the session list." });
      } else {
        toastOnce(`Failed to create session: ${msg}`);
      }
      return null;
    }

    // Switch the api/sse clients to the new session BEFORE refreshing
    // state, otherwise refreshState() reads from the old session.
    setActiveSession(newName);

    // switchToSession handles the full lifecycle: SSE listener cleanup,
    // state reset, history replay, and initial state fetch.
    await useSwarmStore.getState().switchToSession(newName, "live");

    // Update the session store so the subscribe doesn't revert our sync.
    set({ activeSwarm: newName, viewingSession: null });

    // Immediately add the new session to the runs list so it appears in the UI
    // (it won't have a .swarm_* directory until the first run, but we show it anyway)
    const currentRuns = get().runs;
    if (!currentRuns.find(r => r.name === newName)) {
      set({ runs: [{ name: newName, dir: `.swarm_${newName}`, lastActivity: null, messageCount: 0, status: "idle" }, ...currentRuns] });
    } else {
      setTimeout(() => get().loadRuns(), 500);
    }
    return newName;
  },

  switchToSession: async (name: string) => {
    if (name === get().activeSwarm) {
      // Switching to the active session — reload live state.
      set({ viewingSession: null });
      useSwarmStore.getState().switchToSession(name, "live");
      return;
    }
    // Historical read-only view — don't touch the SSE connection.
    set({ viewingSession: name });
    useSwarmStore.getState().switchToSession(name, "historical");
  },

  backToCurrent: () => {
    set({ viewingSession: null });
    useSwarmStore.getState().switchToSession(get().activeSwarm, "live");
  },
}),
{ name: "satopi-sessions" },
),
);

// Whenever the active swarm changes, keep the api-client and sse-client
// module-level variables in sync so ALL components and stores automatically
// target the correct session — no individual caller needs to remember.
useSessionStore.subscribe((state, prevState) => {
  if (state.activeSwarm !== prevState.activeSwarm) {
    setActiveSession(state.activeSwarm);
    setActiveSSESession(state.activeSwarm);
  }
});
