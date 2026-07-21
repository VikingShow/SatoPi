/**
 * SSE client — re-exports pi-web SseClient with swarm-gui URL resolution.
 *
 * Connects to MonitorServer /events endpoint with a query parameter
 * for the active session name so the server routes events correctly.
 *
 * The underlying SseClient is created lazily because the session name
 * is not known at module-load time.
 */
import { SseClient } from "@oh-my-pi/pi-web/sse";
import type { ActivityEntry } from "./types";

let activeSession: string | null = null;

// Bypass Vite proxy for SSE in dev — http-proxy buffers streamed responses,
// which delays or drops real-time events. The backend serves CORS headers
// so a direct cross-origin EventSource connection works fine.
const SSE_BASE = "http://127.0.0.1:7878";

function buildSSEUrl(): string {
  const base = activeSession
    ? `/events?session=${encodeURIComponent(activeSession)}`
    : "/events";
  // In production the backend serves static files and SSE on the same origin,
  // so relative URLs work. In dev (Vite), use the absolute backend URL.
  if (typeof window !== "undefined" && window.location.port !== "7878") {
    return `${SSE_BASE}${base}`;
  }
  return base;
}

/** Update the session name — disconnect old EventSource, update URL, reconnect. */
export function setActiveSSESession(name: string | null): void {
  activeSession = name;
  sseClient.disconnect();
  sseClient.setUrl(buildSSEUrl());
  sseClient.connect();
}

export const sseClient = new SseClient<ActivityEntry>(buildSSEUrl());
