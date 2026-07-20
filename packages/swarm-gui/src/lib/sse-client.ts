/**
 * SSE client — re-exports pi-web SseClient with swarm-gui URL resolution.
 *
 * Connects to MonitorServer /events endpoint with a query parameter
 * for the active session name so the server routes events correctly.
 */
import { SseClient } from "@oh-my-pi/pi-web/sse";
import type { ActivityEntry } from "./types";

let activeSession: string | null = null;

/** Update the session name — effectively reconnects the SSE stream. */
export function setActiveSSESession(name: string | null): void {
  activeSession = name;
}

function getSSEUrl(): string {
  if (activeSession) {
    return `/events?session=${encodeURIComponent(activeSession)}`;
  }
  return "/events";
}

export const sseClient = new SseClient<ActivityEntry>(getSSEUrl());
