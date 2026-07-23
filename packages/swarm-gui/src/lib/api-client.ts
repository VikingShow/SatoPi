/**
 * REST API client — fetch wrapper for MonitorServer endpoints.
 *
 * Session-scoped endpoints are prefixed with /api/session/{name}/.
 * Global endpoints (/api/runs, /api/models, /api/roles, /api/experience)
 * stay at their original paths.
 *
 * Call setActiveSession(name) before making session-scoped calls.
 */

import type { SwarmState, ModelOption, CurtainResult, ExperienceSearchResult, ExperienceStats, ExperienceLesson, ScriptState, TodoItem, BlockerResolution, RoleAsset, RoleAssetSummary, RoleCreateInput, RoleUpdateInput, RoleStatus } from "./types";
import { fetchJson } from "@oh-my-pi/pi-web/fetch";

/** Active session name — set by the session store on init / switch. */
let activeSessionName: string | null = null;

export function setActiveSession(name: string | null): void {
  activeSessionName = name;
}

export function getActiveSession(): string | null {
  return activeSessionName;
}

/**
 * Build a session-scoped API URL.
 *
 * With an active session:  /api/session/{name}{path}
 * Fallback (no session):  /api/{path}          (strips path's leading '/')
 */
function sessionUrl(path: string): string {
  if (!activeSessionName) {
    // path always starts with "/" (e.g. "/state", "/script/start").
    // Strip the leading slash to avoid a double-slash like /api//state.
    const cleanPath = path.replace(/^\/+/, "");
    console.warn(`[api] No active session set when calling /${cleanPath} — falling back to /api/${cleanPath}`);
    return `/api/${cleanPath}`;
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

  deleteSession: (name: string) =>
    fetchJson<{ success: boolean }>("/api/sessions", {
      method: "DELETE",
      body: JSON.stringify({ name }),
    }),

  /** Fork an existing session. Parent must exist. */
  forkSession: (parent: string, name: string) =>
    fetchJson<{ name: string; parent: string }>("/api/sessions/fork", {
      method: "POST",
      body: JSON.stringify({ parent, name }),
    }),

  /** Get the session entry tree (for tree visualization). */
  getSessionTree: () =>
    fetchJson<{ tree: unknown[] }>(sessionUrl("/tree")),

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
        status: "idle" | "stage" | "completed" | "failed";
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

  getCurtainSummary: () =>
    fetchJson<CurtainResult>(sessionUrl("/curtain/summary")),

  // -- Experience (workspace-shared, global) ---------------------------------

  searchExperience: (q: string, limit = 10) =>
    fetchJson<{ results: ExperienceSearchResult[] }>(`/api/experience?q=${encodeURIComponent(q)}&limit=${limit}`),

  getExperienceStats: () =>
    fetchJson<ExperienceStats>("/api/experience/stats"),

  getRecentLessons: (limit = 20) =>
    fetchJson<{ lessons: Array<{ runId: string; timestamp: string; lesson: ExperienceLesson; stats: unknown }> }>(`/api/experience/recent?limit=${limit}`),

  // -- Script phase (session-scoped) -----------------------------------------

  getScriptAgents: () =>
    fetchJson<{ agents: import("./types").AgentSummary[] }>(sessionUrl("/script/agents")),

  startScript: (task: string, agentId?: string) =>
    fetchJson<{ success: boolean; error?: string }>(sessionUrl("/script/start"), {
      method: "POST",
      body: JSON.stringify({ task, agentId }),
    }),

  sendScriptMessage: (text: string) =>
    fetchJson<{ success: boolean; error?: string }>(sessionUrl("/script/message"), {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  getScriptState: () =>
    fetchJson<ScriptState>(sessionUrl("/script/state")),

  loadScriptHistory: () =>
    fetchJson<{ history: Array<{ role: string; content: string }> }>(sessionUrl("/script/history")),

  runDebate: () =>
    fetchJson<{ success: boolean; error?: string }>(sessionUrl("/script/debate"), {
      method: "POST",
    }),

  confirmScript: (opts?: { agentCount?: number; reviewerCount?: number }) =>
    fetchJson<{ success: boolean; error?: string }>(sessionUrl("/script/confirm"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentCount: opts?.agentCount, agentCount: opts?.agentCount }),
    }),

  cancelScript: () =>
    fetchJson<{ success: boolean; error?: string }>(sessionUrl("/script/cancel"), {
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

  // -- Curtain (session-scoped) ----------------------------------------------

  applaud: () =>
    fetchJson<{ success: boolean; message?: string }>(sessionUrl("/curtain/applaud"), {
      method: "POST",
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
