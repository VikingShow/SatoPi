/**
 * REST API client — fetch wrapper for MonitorServer endpoints.
 */

import type { SwarmState, ModelOption, AfterLoopResult, ExperienceSearchResult, ExperienceStats, ExperienceLesson, BeforeLoopState, LoopPhase, TodoItem } from "./types";

const BASE = "";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = `API error: ${res.status} ${res.statusText}`;
    console.error(msg, body);
    const err = new Error(msg) as Error & { status?: number; body?: unknown };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json() as Promise<T>;
}

export const api = {
  getState: () => fetchJson<SwarmState>("/api/state"),

  getConfig: () => fetchJson<{ yaml: string; error?: string }>("/api/config"),

  saveConfig: (yaml: string) =>
    fetchJson<{ success?: boolean; error?: string }>("/api/config", {
      method: "PUT",
      body: JSON.stringify({ yaml }),
    }),

  getHistory: () =>
    fetchJson<{ entries: unknown[] }>("/api/history"),

  getRuns: () =>
    fetchJson<{ runs: { name: string; dir: string }[] }>("/api/runs"),

  getModels: () =>
    fetchJson<{ models: ModelOption[] }>("/api/models"),

  getPlan: () =>
    fetchJson<{ content: string; path?: string; error?: string }>("/api/plan"),

  savePlan: (content: string) =>
    fetchJson<{ success?: boolean; path?: string; error?: string }>("/api/plan", {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),

  getPlanTodos: () =>
    fetchJson<{ todos: TodoItem[] }>("/api/plan/todos"),

  startRun: () =>
    fetchJson<{ success: boolean; error?: string }>("/api/run/start", {
      method: "POST",
    }),

  stopRun: () =>
    fetchJson<{ success: boolean; error?: string }>("/api/run/stop", {
      method: "POST",
    }),

  getRunStatus: () =>
    fetchJson<{ running: boolean }>("/api/run/status"),

  getAfterLoopSummary: () =>
    fetchJson<AfterLoopResult>("/api/after-loop/summary"),

  searchExperience: (q: string, limit = 10) =>
    fetchJson<{ results: ExperienceSearchResult[] }>(`/api/experience?q=${encodeURIComponent(q)}&limit=${limit}`),

  getExperienceStats: () =>
    fetchJson<ExperienceStats>("/api/experience/stats"),

  getRecentLessons: (limit = 20) =>
    fetchJson<{ lessons: Array<{ runId: string; timestamp: string; lesson: ExperienceLesson; stats: unknown }> }>(`/api/experience/recent?limit=${limit}`),

  // ── Before Loop (interactive planning) ──

  startBeforeLoop: (task: string) =>
    fetchJson<{ success: boolean; error?: string }>("/api/before-loop/start", {
      method: "POST",
      body: JSON.stringify({ task }),
    }),

  sendBeforeLoopMessage: (text: string) =>
    fetchJson<{ success: boolean; error?: string }>("/api/before-loop/message", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  getBeforeLoopState: () =>
    fetchJson<BeforeLoopState>("/api/before-loop/state"),

  getBeforeLoopHistory: () =>
    fetchJson<{ history: Array<{ role: string; content: string }> }>("/api/before-loop/history"),

  runDebate: () =>
    fetchJson<{ success: boolean; error?: string }>("/api/before-loop/debate", {
      method: "POST",
    }),

  confirmBeforeLoop: () =>
    fetchJson<{ success: boolean; error?: string }>("/api/before-loop/confirm", {
      method: "POST",
    }),

  cancelBeforeLoop: () =>
    fetchJson<{ success: boolean; error?: string }>("/api/before-loop/cancel", {
      method: "POST",
    }),

  // ── Steering (operator → running loop) ──

  sendSteering: (text: string) =>
    fetchJson<{ success: boolean; error?: string }>("/api/run/steer", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
};
