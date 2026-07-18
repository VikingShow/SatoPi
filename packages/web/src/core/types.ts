/**
 * Generic types for SatoPi web apps.
 * Shared between swarm-gui and collab-web.
 */

// ── Generic SSE event ──
export interface SseEvent {
  ts: number;
  type: string;
  [key: string]: unknown;
}

// ── Chat primitives ──
export interface ChatMessage {
  id: string;
  from: string;
  body: string;
  timestamp: number;
  channelId?: string;
}

export interface ChatChannel {
  id: string;
  name: string;
  type: "roundtable" | "subgroup" | "private" | "steering" | string;
  participants: string[];
  messageCount: number;
}
