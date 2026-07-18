/**
 * Session store — manages swarm run sessions.
 *
 * A "session" is a single swarm run lifecycle:
 *   before-loop → running → after-loop
 *
 * "New Session" clears the current run state and starts fresh.
 */

import { create } from "zustand";
import { api } from "../lib/api-client";
import { useSwarmStore } from "./swarm-store";

interface SessionStore {
  currentRunId: string;
  runs: Array<{ name: string; dir: string }>;

  loadRuns: () => Promise<void>;
  newSession: () => Promise<void>;
  setCurrentRun: (name: string) => void;
}

function generateRunId(): string {
  return `run-${Date.now()}`;
}

export const useSessionStore = create<SessionStore>((set) => ({
  currentRunId: generateRunId(),
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

    // Reset the swarm store
    const swarmStore = useSwarmStore.getState();
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
    // Re-init to reconnect SSE and poll state
    await swarmStore.refreshState();

    set({ currentRunId: generateRunId() });
    // Reload run list
    setTimeout(() => set((s) => { s.loadRuns(); return {}; }), 500);
  },

  setCurrentRun: (name) => set({ currentRunId: name }),
}));
