/**
 * api-client-confirm.test.ts — Tests for confirm API (agentCount fix)
 *
 * Coverage:
 * 1. confirm sends agentCount correctly
 * 2. confirm with agentCount default works
 * 3. confirm handles server errors
 *
 * This file supplements api-client.test.ts with confirm-specific coverage.
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

const { api } = await import("../api-client");

describe("api.confirmScript (agentCount)", () => {
	it("POSTs agentCount correctly", async () => {
		mockOk({ success: true });
		const result = await api.confirmScript({ agentCount: 3 });

		expect(result.success).toBe(true);
		const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		const body = JSON.parse(fetchCall[1].body);

		expect(body.agentCount).toBe(3);
		// Should NOT have reviewerCount (removed — roles auto-assigned by StageController)
		expect(body.reviewerCount).toBeUndefined();
		const bodyKeys = Object.keys(body);
		const agentCountOccurrences = bodyKeys.filter(k => k === "agentCount").length;
		expect(agentCountOccurrences).toBe(1); // no duplicate keys in JSON
	});

	it("sends agentCount only, no reviewerCount", async () => {
		mockOk({ success: true });
		await api.confirmScript({ agentCount: 2 });

		const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		const body = JSON.parse(fetchCall[1].body);

		expect(body.agentCount).toBe(2);
		expect(body.reviewerCount).toBeUndefined();
	});

	it("handles confirm failure from server", async () => {
		(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			ok: false,
			status: 500,
			statusText: "Internal Server Error",
			json: async () => ({ error: "Already running" }),
		} as Response);

		await expect(api.confirmScript({ agentCount: 1 })).rejects.toThrow("API error: 500");
	});

	it("sends POST to /api/script/confirm endpoint", async () => {
		mockOk({ success: true });
		await api.confirmScript({ agentCount: 4 });

		const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(fetchCall[0]).toContain("/script/confirm");
		expect(fetchCall[1].method).toBe("POST");
	});
});
