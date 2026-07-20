/**
 * SSE client — re-exports pi-web SseClient with swarm-gui URL resolution.
 *
 * Connects to MonitorServer /events endpoint.
 */
import { SseClient } from "@oh-my-pi/pi-web/sse";
import type { ActivityEntry } from "./types";

/** Always use the Vite proxy path — /events is proxied to backend in both dev and prod. */
function getSSEUrl(): string {
  return "/events";
}

export const sseClient = new SseClient<ActivityEntry>(getSSEUrl());
