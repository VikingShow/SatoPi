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
/** The URL we most recently connected to. Used to short-circuit duplicate calls. */
let currentUrl: string | null = null;

// Bypass Vite proxy for SSE in dev — http-proxy buffers streamed responses,
// which delays or drops real-time events. Use the same host as the page so
// the browser never blocks the connection as private-network access.
const SSE_PORT = 7878;

function buildSSEUrl(session: string | null): string {
  const base = session
    ? `/events?session=${encodeURIComponent(session)}`
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
 * succession.  We short-circuit when the resolved URL is unchanged — no
 * need to tear down a healthy connection and re-establish it for the same
 * target, which causes a "Reconnecting" flicker and a gap in events.
 */
export function setActiveSSESession(name: string | null): void {
  const newUrl = buildSSEUrl(name);
  if (newUrl === currentUrl) {
    // Same target — the existing connection (or in-flight connection) is fine.
    // Update activeSession in case name changed but resolved to the same URL
    // (e.g. null → null edge case).
    activeSession = name;
    return;
  }
  currentUrl = newUrl;
  activeSession = name;
  sseClient.disconnect();
  sseClient.setUrl(newUrl);
  sseClient.connect();
}

export const sseClient = new SseClient<ActivityEntry>(buildSSEUrl(activeSession));
