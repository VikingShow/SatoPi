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

  newSession: async () => {
    // Cancel any active before-loop
    try { await api.cancelBeforeLoop(); } catch {}
    // Stop any running swarm
    try { await api.stopRun(); } catch {}

    // Generate a new unique name (visible to the user immediately)
    const newName = generateSwarmName();

    // Create the session on the backend (creates .swarm_{name}/ directory
    // and session services).  Call this BEFORE updating the YAML so the
    // backend has the session ready when the UI switches.
    try { await api.createSession(newName); } catch { /* ok if exists */ }

    // Update the YAML's swarm.name so a restart picks up the new name.
    try {
      const { yaml } = await api.getConfig();
      const updated = yaml.replace(/^(\s*name:\s*).+$/m, `$1${newName}`);
      await api.saveConfig(updated);
    } catch {
      // If YAML update fails, still continue — backend will use the new name on next run
    }

    // Switch the api/sse clients to the new session BEFORE refreshing
    // state, otherwise refreshState() reads from the old session.
    setActiveSession(newName);
    setActiveSSESession(newName);

    // Reset the swarm store to a clean idle state
    useSwarmStore.setState({
      swarmState: null,
      activities: [],
      channels: new Map(),
      messages: new Map(),
      activeChannelId: null,
      loopPhase: "idle",
      beforeLoopState: null,
      planVersion: 0,
      todos: [],
      afterLoopResult: null,
      blockerContext: null,
      error: null,
    });

    // Update the session store so the subscribe doesn't revert our sync.
    set({ activeSwarm: newName, viewingSession: null });

    // Refresh state from the new session.
    const swarmStore = useSwarmStore.getState();
    await swarmStore.refreshState();
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
      // Switching to the active session just clears any read-only view
      set({ viewingSession: null });
      return;
    }
    // Load historical activity into a read-only view (without affecting live state)
    try {
      const { entries } = await api.getRunActivity(name);
      const activities = entries as ActivityEntry[];
      useSwarmStore.setState({
        activities,
        channels: new Map(),
        messages: new Map(),
        activeChannelId: "roundtable",
        // Don't change loopPhase — keep showing live status in the header
        beforeLoopState: null,
        planVersion: 0,
        todos: [],
        afterLoopResult: null,
        blockerContext: null,
        error: null,
        // Repopulate channels/messages from the historical activity
      });
      // Replay entries to populate channels and messages
      for (const entry of activities) {
        useSwarmStore.getState().addActivity(entry, true);
      }
      set({ viewingSession: name });
    } catch (err) {
      console.error(`Failed to switch to session ${name}:`, err);
    }
  },

  backToCurrent: () => {
    set({ viewingSession: null });
    // Re-init to reload live state
    useSwarmStore.getState().init();
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
