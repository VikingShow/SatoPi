/**
 * sse-client.test.ts — Unit tests for SSE client (EventSource wrapper).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock EventSource
class MockEventSource {
  static instances: MockEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string; lastEventId?: string }) => void) | null = null;
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

const { SseClient } = await import("@oh-my-pi/pi-web/sse");

function createClient() {
  return new SseClient("http://localhost:7878/events");
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.clearAllTimers();
});

afterEach(() => {
  vi.clearAllTimers();
});

describe("SseClient", () => {
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

  // Regression: the setActiveSSESession pattern is disconnect() → connect().
  // disconnect() sets shouldReconnect=false; connect() MUST re-arm it,
  // otherwise the client is permanently stuck after the first session switch
  // and never recovers from a transient onerror ("Reconnecting" forever).
  it("re-arms auto-reconnect after a disconnect()→connect() cycle", () => {
    const client = createClient();
    client.connect();
    // Simulate setActiveSSESession: tear down, then reconnect.
    client.disconnect();
    client.connect();
    expect(MockEventSource.instances.length).toBe(2);

    // A transient error on the new connection must still schedule a reconnect.
    const src = MockEventSource.instances[1];
    src.onerror?.();
    vi.advanceTimersByTime(1500);
    expect(MockEventSource.instances.length).toBe(3); // recovered!
  });

  it("appends lastEventId to the reconnect URL for gap replay", () => {
    const client = createClient();
    client.connect();
    const src = MockEventSource.instances[0];
    src.readyState = MockEventSource.OPEN;
    // Receive an event carrying an SSE id.
    src.onmessage?.({ data: JSON.stringify({ ts: 1, type: "phase" }), lastEventId: "42" });
    // Force a reconnect via error.
    src.readyState = MockEventSource.CLOSED;
    src.onerror?.();
    vi.advanceTimersByTime(1500);
    const reconnected = MockEventSource.instances[1];
    expect(reconnected.url).toContain("lastEventId=42");
  });

  it("resets lastEventId on setUrl (new session must not resume stale id)", () => {
    const client = createClient();
    client.connect();
    const src = MockEventSource.instances[0];
    src.onmessage?.({ data: JSON.stringify({ ts: 1, type: "phase" }), lastEventId: "42" });
    // Switch target — should forget the resume cursor.
    client.setUrl("http://localhost:7878/events?session=new");
    client.disconnect();
    client.connect();
    const fresh = MockEventSource.instances[MockEventSource.instances.length - 1];
    expect(fresh.url).not.toContain("lastEventId");
    expect(fresh.url).toContain("session=new");
  });

  it("keeps reconnecting across repeated session switches", () => {
    const client = createClient();
    // Three consecutive session switches.
    for (let i = 0; i < 3; i++) {
      client.disconnect();
      client.connect();
    }
    const last = MockEventSource.instances[MockEventSource.instances.length - 1];
    last.onerror?.();
    vi.advanceTimersByTime(1500);
    // Still reconnects after the last switch.
    expect(
      MockEventSource.instances.length,
    ).toBeGreaterThan(3);
  });
});
