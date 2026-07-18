/**
 * SSE client — connects to MonitorServer /events endpoint.
 *
 * Receives ActivityEntry events in real-time. Auto-reconnects on disconnect
 * with exponential backoff. Includes heartbeat detection and event-type
 * filtering for efficient UI updates.
 */

import type { ActivityEntry } from "./types";

type EventHandler = (entry: ActivityEntry) => void;
type ConnectionHandler = (connected: boolean) => void;

export class SSEClient {
  private eventSource: EventSource | null = null;
  private listeners = new Set<EventHandler>();
  private connectionListeners = new Set<ConnectionHandler>();
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldReconnect = true;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private getSSEUrl(): string {
    // Production: use same-origin (reverse proxy like nginx handles routing)
    // Development: connect directly to backend on port 7878
    const host = window.location.hostname;
    const port = window.location.port;

    // If the frontend is served from a non-default port (dev mode),
    // connect directly to the backend port
    if (port && (port === "80" || port === "")) {
      // Production or vite dev on port 80 — use reverse proxy
      return "/events";
    }
    // Dev mode on other ports (e.g. vite default 5173) — direct connection
    return `http://${host}:7878/events`;
  }

  connect(): void {
    if (this.eventSource?.readyState === EventSource.OPEN) return;

    this.eventSource = new EventSource(this.getSSEUrl());

    this.eventSource.onopen = () => {
      this.reconnectDelay = 1000;
      this.startHeartbeat();
      this.notifyConnection(true);
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
      this.stopHeartbeat();
      this.notifyConnection(false);

      if (this.shouldReconnect) {
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        setTimeout(() => this.connect(), delay);
      }
    };
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    this.eventSource?.close();
    this.eventSource = null;
    this.notifyConnection(false);
  }

  /** Subscribe to incoming ActivityEntry events */
  on(handler: EventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** Subscribe to connection state changes (for UI indicators) */
  onConnectionChange(handler: ConnectionHandler): () => void {
    this.connectionListeners.add(handler);
    return () => this.connectionListeners.delete(handler);
  }

  get isConnected(): boolean {
    return this.eventSource?.readyState === EventSource.OPEN;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // Check connection every 15 seconds
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected) {
        this.stopHeartbeat();
        this.notifyConnection(false);
        // Force reconnect
        this.eventSource?.close();
        this.eventSource = null;
        if (this.shouldReconnect) {
          this.connect();
        }
      }
    }, 15000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private notifyConnection(connected: boolean): void {
    for (const handler of this.connectionListeners) {
      handler(connected);
    }
  }
}

export const sseClient = new SSEClient();
