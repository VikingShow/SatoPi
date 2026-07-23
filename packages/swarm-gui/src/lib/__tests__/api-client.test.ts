/**
 * api-client.test.ts — Unit tests for REST API client (fetch wrapper).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockOk<T>(data: T) {
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => data,
  } as Response);
}

function mockError(status: number, body?: unknown) {
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    ok: false,
    status,
    statusText: status === 500 ? "Internal Server Error" : "Not Found",
    json: async () => body ?? {},
  } as Response);
}

// Dynamic import so vitest resolves it after mocks are set
const { api } = await import("../api-client");

describe("api.getState", () => {
  it("returns SwarmState on success", async () => {
    const state = { name: "demo", status: "idle", phase: "script-dialog" };
    mockOk(state);
    const result = await api.getState();
    expect(result).toEqual(state);
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("throws on non-200 response", async () => {
    mockError(500);
    await expect(api.getState()).rejects.toThrow("API error: 500");
  });
});

describe("api.getConfig", () => {
  it("returns config YAML", async () => {
    mockOk({ yaml: "swarm:\n  name: test" });
    const result = await api.getConfig();
    expect(result.yaml).toContain("swarm:");
  });
});

describe("api.startScript", () => {
  it("POSTs task and returns success", async () => {
    mockOk({ success: true });
    const result = await api.startScript("build auth");
    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/script/start", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ task: "build auth" }),
    }));
  });

  it("returns error from backend", async () => {
    mockOk({ success: false, error: "Already running" });
    const result = await api.startScript("test");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Already running");
  });
});

describe("api.cancelScript", () => {
  it("sends POST with no body", async () => {
    mockOk({ success: true });
    const result = await api.cancelScript();
    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/script/cancel", expect.objectContaining({ method: "POST" }));
  });
});

describe("api.resolveBlocker", () => {
  it("sends decision payload", async () => {
    mockOk({ success: true });
    const result = await api.resolveBlocker("continue");
    expect(result.success).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/run/resolve-blocker", expect.objectContaining({
      body: JSON.stringify({ decision: "continue" }),
    }));
  });

  it("handles error on server failure", async () => {
    mockError(500, { error: "No blocker active" });
    await expect(api.resolveBlocker("abort")).rejects.toThrow("API error: 500");
  });
});
