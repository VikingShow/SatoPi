/**
 * sse-client.test.ts — Unit tests for SSE client (EventSource wrapper).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 2;

  constructor(public url: string) {
    MockEventSource.instances.push(this);
    this.readyState = MockEventSource.CONNECTING;
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

vi.stubGlobal("EventSource", MockEventSource);
vi.useFakeTimers();

const { SSEClient } = await import("../sse-client");

function createClient() {
  return new SSEClient();
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.clearAllTimers();
});

afterEach(() => {
  vi.clearAllTimers();
});

describe("SSEClient", () => {
  it("connect creates EventSource", () => {
    const client = createClient();
    client.connect();
    expect(MockEventSource.instances.length).toBe(1);
  });

  it("double connect does not create duplicate", () => {
    const client = createClient();
    client.connect();
    const src = MockEventSource.instances[0];
    src.readyState = MockEventSource.OPEN;
    client.connect();
    expect(MockEventSource.instances.length).toBe(1);
  });

  it("receives message events via on() callback", async () => {
    const client = createClient();
    const handler = vi.fn();
    client.on(handler);
    client.connect();

    const src = MockEventSource.instances[0];
    src.onmessage?.({ data: JSON.stringify({ ts: 1, type: "phase", phase: "running" }) });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "phase", phase: "running" })
    );
  });

  it("disconnect stops reconnect attempts", () => {
    const client = createClient();
    client.connect();
    const src = MockEventSource.instances[0];
    client.disconnect();

    src.onerror?.();
    vi.advanceTimersByTime(5000);
    // Should NOT have created a second EventSource after disconnect
    expect(MockEventSource.instances.length).toBe(1);
  });

  it("reconnects on error with backoff", () => {
    const client = createClient();
    client.connect();
    const src = MockEventSource.instances[0];

    // Trigger error — should schedule reconnect with 1s delay
    src.onerror?.();
    expect(MockEventSource.instances.length).toBe(1);

    vi.advanceTimersByTime(1500);
    expect(MockEventSource.instances.length).toBe(2); // reconnected!
  });

  it("isConnected reflects readyState after open", () => {
    const client = createClient();
    expect(client.isConnected).toBe(false);
    client.connect();
    const src = MockEventSource.instances[0];
    src.readyState = MockEventSource.OPEN;
    expect(client.isConnected).toBe(true);
  });
});
