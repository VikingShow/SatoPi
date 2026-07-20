/**
 * REST API client — fetch wrapper for MonitorServer endpoints.
 *
 * Session-scoped endpoints are prefixed with /api/session/{name}/.
 * Global endpoints (/api/runs, /api/models, /api/roles, /api/experience)
 * stay at their original paths.
 *
 * Call setActiveSession(name) before making session-scoped calls.
 */

import type { SwarmState, ModelOption, AfterLoopResult, ExperienceSearchResult, ExperienceStats, ExperienceLesson, BeforeLoopState, TodoItem, BlockerResolution, RoleAsset, RoleAssetSummary, RoleCreateInput, RoleUpdateInput, RoleStatus } from "./types";
import { fetchJson } from "@oh-my-pi/pi-web/fetch";

/** Active session name — set by the session store on init / switch. */
let activeSessionName: string | null = null;

export function setActiveSession(name: string | null): void {
  activeSessionName = name;
}

export function getActiveSession(): string | null {
  return activeSessionName;
}

function sessionUrl(path: string): string {
  if (!activeSessionName) {
    console.warn(`[api] No active session set when calling ${path} — falling back to /api/${path}`);
    return `/api/${path}`;
  }
  return `/api/session/${encodeURIComponent(activeSessionName)}${path}`;
}

export const api = {
  // -- Session management ---------------------------------------------------

  /** Set the active session so subsequent calls are routed correctly. */
  setSession: (name: string | null) => setActiveSession(name),

  /** Create a new session on the backend (global endpoint). */
  createSession: (name: string) =>
    fetchJson<{ name: string; exists: boolean }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  getState: () => fetchJson<SwarmState>(sessionUrl("/state")),

  getConfig: () => fetchJson<{ yaml: string; error?: string }>(sessionUrl("/config")),

  saveConfig: (yaml: string) =>
    fetchJson<{ success?: boolean; error?: string }>(sessionUrl("/config"), {
      method: "PUT",
      body: JSON.stringify({ yaml }),
    }),

  getHistory: (since?: number) =>
    fetchJson<{ entries: unknown[] }>(
      sessionUrl(`/history${since ? `?since=${since}` : ""}`),
    ),

  // -- Runs (global — lists all sessions) -----------------------------------

  getRuns: () =>
    fetchJson<{
      runs: Array<{
        name: string;
        dir: string;
        lastActivity: string | null;
        messageCount: number;
        status: "idle" | "running" | "completed" | "failed";
      }>;
    }>("/api/runs"),

  getRunActivity: (name: string) =>
    fetchJson<{ entries: unknown[] }>(`/api/runs/${encodeURIComponent(name)}/activity`),

  getRunMeta: (name: string) =>
    fetchJson<{ name: string; dir: string; messageCount: number }>(`/api/runs/${encodeURIComponent(name)}`),

  // -- Models (global) ------------------------------------------------------

  getModels: () =>
    fetchJson<{ models: ModelOption[] }>("/api/models"),

  // -- Plan (session-scoped) ------------------------------------------------

  getPlan: () =>
    fetchJson<{ content: string; path?: string; error?: string }>(sessionUrl("/plan")),

  savePlan: (content: string) =>
    fetchJson<{ success?: boolean; path?: string; error?: string }>(sessionUrl("/plan"), {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),

  getPlanTodos: () =>
    fetchJson<{ todos: TodoItem[] }>(sessionUrl("/plan/todos")),

  // -- Run control (session-scoped) -----------------------------------------

  startRun: () =>
    fetchJson<{ success: boolean; error?: string }>(sessionUrl("/run/start"), {
      method: "POST",
    }),

  stopRun: () =>
    fetchJson<{ success: boolean; error?: string }>(sessionUrl("/run/stop"), {
      method: "POST",
    }),

  getRunStatus: () =>
    fetchJson<{ running: boolean }>(sessionUrl("/run/status")),

  pauseRun: () =>
    fetchJson<{ success: boolean; error?: string }>(sessionUrl("/run/pause"), {
      method: "POST",
    }),

  resumeRun: () =>
    fetchJson<{ success: boolean; error?: string }>(sessionUrl("/run/resume"), {
      method: "POST",
    }),

  // -- After Loop (session-scoped) ------------------------------------------

  getAfterLoopSummary: () =>
    fetchJson<AfterLoopResult>(sessionUrl("/after-loop/summary")),

  // -- Experience (workspace-shared, global) ---------------------------------

  searchExperience: (q: string, limit = 10) =>
    fetchJson<{ results: ExperienceSearchResult[] }>(`/api/experience?q=${encodeURIComponent(q)}&limit=${limit}`),

  getExperienceStats: () =>
    fetchJson<ExperienceStats>("/api/experience/stats"),

  getRecentLessons: (limit = 20) =>
    fetchJson<{ lessons: Array<{ runId: string; timestamp: string; lesson: ExperienceLesson; stats: unknown }> }>(`/api/experience/recent?limit=${limit}`),

  // -- Before Loop (session-scoped) ------------------------------------------

  startBeforeLoop: (task: string) =>
    fetchJson<{ success: boolean; error?: string }>(sessionUrl("/before-loop/start"), {
      method: "POST",
      body: JSON.stringify({ task }),
    }),

  sendBeforeLoopMessage: (text: string) =>
    fetchJson<{ success: boolean; error?: string }>(sessionUrl("/before-loop/message"), {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  getBeforeLoopState: () =>
    fetchJson<BeforeLoopState>(sessionUrl("/before-loop/state")),

  getBeforeLoopHistory: () =>
    fetchJson<{ history: Array<{ role: string; content: string }> }>(sessionUrl("/before-loop/history")),

  runDebate: () =>
    fetchJson<{ success: boolean; error?: string }>(sessionUrl("/before-loop/debate"), {
      method: "POST",
    }),

  confirmBeforeLoop: () =>
    fetchJson<{ success: boolean; error?: string }>(sessionUrl("/before-loop/confirm"), {
      method: "POST",
    }),

  cancelBeforeLoop: () =>
    fetchJson<{ success: boolean; error?: string }>(sessionUrl("/before-loop/cancel"), {
      method: "POST",
    }),

  // -- Steering (session-scoped) --------------------------------------------

  sendSteering: (text: string) =>
    fetchJson<{ success: boolean; error?: string }>(sessionUrl("/run/steer"), {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  // -- Blocker resolution (session-scoped) -----------------------------------

  resolveBlocker: (decision: BlockerResolution) =>
    fetchJson<{ success: boolean; error?: string }>(sessionUrl("/run/resolve-blocker"), {
      method: "POST",
      body: JSON.stringify({ decision }),
    }),

  // -- Role Asset Library (global) ------------------------------------------

  getRoles: (status?: RoleStatus) => {
    const params = status ? `?status=${encodeURIComponent(status)}` : "";
    return fetchJson<{ roles: RoleAssetSummary[] }>(`/api/roles${params}`);
  },

  getRole: (id: string) =>
    fetchJson<RoleAsset>(`/api/roles/${encodeURIComponent(id)}`),

  createRole: (input: RoleCreateInput) =>
    fetchJson<RoleAsset>("/api/roles", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  updateRole: (id: string, input: RoleUpdateInput) =>
    fetchJson<RoleAsset>(`/api/roles/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  approveRole: (id: string) =>
    fetchJson<RoleAsset>(`/api/roles/${encodeURIComponent(id)}/approve`, {
      method: "POST",
    }),

  deprecateRole: (id: string) =>
    fetchJson<RoleAsset>(`/api/roles/${encodeURIComponent(id)}/deprecate`, {
      method: "POST",
    }),

  deleteRole: (id: string) =>
    fetchJson<{ success: boolean; error?: string }>(`/api/roles/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  searchRoles: (params: { tag?: string; status?: RoleStatus; q?: string }) => {
    const sp = new URLSearchParams();
    if (params.tag) sp.set("tag", params.tag);
    if (params.status) sp.set("status", params.status);
    if (params.q) sp.set("q", params.q);
    return fetchJson<{ roles: RoleAssetSummary[] }>(`/api/roles?${sp.toString()}`);
  },
};
