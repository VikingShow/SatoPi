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
  to?: string;
  /** True while the message is being streamed token-by-token (not yet finalised). */
  streaming?: boolean;
  /** Model chain-of-thought — shown in a collapsible ThinkingBlock after stream_end. */
  thinking?: string;
  /** Timestamp when stream_start was received — used for TTFT measurement. */
  streamCreatedAt?: number;
}

export interface ChatChannel {
  id: string;
  name: string;
  type: "roundtable" | "subgroup" | "private" | "steering" | string;
  participants: string[];
  messageCount: number;
}
