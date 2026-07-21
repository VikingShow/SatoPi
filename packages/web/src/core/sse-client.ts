/**
 * Generic SSE client — subscribes to Server-Sent Events with auto-reconnect.
 *
 * Parameterized by event type T. Supports heartbeat detection, exponential
 * backoff reconnection, and connection state listeners.
 */
export type SseEventHandler<T> = (event: T) => void;
export type ConnectionHandler = (connected: boolean) => void;

export class SseClient<T = Record<string, unknown>> {
  private eventSource: EventSource | null = null;
  private listeners = new Set<SseEventHandler<T>>();
  private connectionListeners = new Set<ConnectionHandler>();
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private shouldReconnect = true;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Last SSE `id:` seen on the current target. Appended to the reconnect URL
   * as `lastEventId` so the server can replay events missed during the gap.
   * Reset on setUrl() because a new target (e.g. a different session) has its
   * own history and must not resume from an unrelated id.
   */
  private lastEventId: string | null = null;

  constructor(private url: string) {}

  /** Update the target URL (e.g. after session change). Does NOT reconnect. */
  setUrl(url: string): void {
    this.url = url;
    // New target → forget the previous stream's resume position.
    this.lastEventId = null;
  }

  /** Build the effective connect URL, appending the resume cursor when present. */
  private buildConnectUrl(): string {
    if (!this.lastEventId) return this.url;
    const sep = this.url.includes("?") ? "&" : "?";
    return `${this.url}${sep}lastEventId=${encodeURIComponent(this.lastEventId)}`;
  }

  connect(): void {
    if (this.eventSource?.readyState === EventSource.OPEN) return;

    // Re-arm auto-reconnect. A prior disconnect() sets shouldReconnect=false;
    // an explicit connect() is always an intent to (re)establish a live link,
    // so we must restore the reconnect intent here — otherwise the very first
    // disconnect()→connect() cycle permanently disables reconnection and any
    // later transient onerror leaves the client stuck in "Reconnecting".
    this.shouldReconnect = true;

    this.eventSource = new EventSource(this.buildConnectUrl());

    this.eventSource.onopen = () => {
      this.reconnectDelay = 1000;
      this.startHeartbeat();
      this.notifyConnection(true);
    };

    this.eventSource.onmessage = (event) => {
      // Track the resume cursor for Last-Event-ID gap recovery.
      if (event.lastEventId) this.lastEventId = event.lastEventId;
      try {
        const entry = JSON.parse(event.data) as T;
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

  on(handler: SseEventHandler<T>): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  onConnectionChange(handler: ConnectionHandler): () => void {
    this.connectionListeners.add(handler);
    return () => this.connectionListeners.delete(handler);
  }

  get isConnected(): boolean {
    return this.eventSource?.readyState === EventSource.OPEN;
  }

  /** True while the EventSource is establishing the connection (readyState 0). */
  get isConnecting(): boolean {
    return this.eventSource?.readyState === 0;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.isConnected) {
        this.stopHeartbeat();
        this.notifyConnection(false);
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
