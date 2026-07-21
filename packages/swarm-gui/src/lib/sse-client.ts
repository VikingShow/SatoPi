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
// which delays or drops real-time events. Use the same host as the page so
// the browser never blocks the connection as private-network access.
const SSE_PORT = 7878;

function buildSSEUrl(): string {
  const base = activeSession
    ? `/events?session=${encodeURIComponent(activeSession)}`
    : "/events";
  // In production the backend serves static files and SSE on the same origin,
  // so relative URLs work. In dev (Vite), use the absolute backend URL on the
  // SAME host as the page so the browser never blocks it as a private-network
  // request (e.g. page at 21.214.42.15:5173 → backend at 21.214.42.15:7878).
  if (typeof window !== "undefined" && window.location.port !== "7878") {
    return `http://${window.location.hostname}:${SSE_PORT}${base}`;
  }
  return base;
}

/**
 * Update the session name — disconnect old EventSource, update URL, reconnect.
 *
 * Idempotent: this is invoked from multiple call sites (swarm-store.init and
 * session-store.subscribe) that can fire for the same session in quick
 * succession. Reconnecting to the exact same session while already live would
 * needlessly tear down a healthy stream (causing a "Reconnecting" flicker and
 * a gap in events), so we short-circuit when the target session is unchanged
 * and the socket is already open.
 */
export function setActiveSSESession(name: string | null): void {
  if (name === activeSession && sseClient.isConnected) {
    return;
  }
  activeSession = name;
  sseClient.disconnect();
  sseClient.setUrl(buildSSEUrl());
  sseClient.connect();
}

export const sseClient = new SseClient<ActivityEntry>(buildSSEUrl());
