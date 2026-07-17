/**
 * SSE client — connects to MonitorServer /events endpoint.
 *
 * Receives ActivityEntry events in real-time. Auto-reconnects on disconnect
 * with exponential backoff.
 */

import type { ActivityEntry } from "./types";

type EventHandler = (entry: ActivityEntry) => void;

export class SSEClient {
  private eventSource: EventSource | null = null;
  private listeners = new Set<EventHandler>();
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldReconnect = true;

  connect(): void {
    if (this.eventSource?.readyState === EventSource.OPEN) return;

    this.eventSource = new EventSource("/events");

    this.eventSource.onopen = () => {
      this.reconnectDelay = 1000;
    };

    this.eventSource.onmessage = (event) => {
      try {
        const entry = JSON.parse(event.data) as ActivityEntry;
        for (const listener of this.listeners) {
          listener(entry);
        }
      } catch (err) {
        console.error("Failed to parse SSE event:", err);
      }
    };

    this.eventSource.onerror = () => {
      this.eventSource?.close();
      this.eventSource = null;

      if (this.shouldReconnect) {
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      }
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.eventSource?.close();
    this.eventSource = null;
  }

  on(handler: EventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  get isConnected(): boolean {
    return this.eventSource?.readyState === EventSource.OPEN;
  }
}

export const sseClient = new SSEClient();
