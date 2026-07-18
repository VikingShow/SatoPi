/**
 * SSE client — re-exports pi-web SseClient with swarm-gui URL resolution.
 *
 * Connects to MonitorServer /events endpoint.
 */
import { SseClient } from "@oh-my-pi/pi-web/sse";
import type { ActivityEntry } from "./types";

/** Resolve the SSE endpoint URL based on runtime environment. */
function getSSEUrl(): string {
  const host = window.location.hostname;
  const port = window.location.port;
  // Prod or vite dev on port 80 → use reverse proxy
  if (port && (port === "80" || port === "")) return "/events";
  // Dev mode → direct connection
  return `http://${host}:7878/events`;
}

export const sseClient = new SseClient<ActivityEntry>(getSSEUrl());
