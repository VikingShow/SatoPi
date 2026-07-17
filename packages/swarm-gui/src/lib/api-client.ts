/**
 * REST API client — fetch wrapper for MonitorServer endpoints.
 */

import type { SwarmState, ModelOption } from "./types";

const BASE = "";

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) console.error(`API error: ${res.status} ${res.statusText}`);
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
};
