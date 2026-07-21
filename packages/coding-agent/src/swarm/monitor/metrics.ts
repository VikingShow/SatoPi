/**
 * Prometheus metrics registry for SatoPi swarm monitor.
 *
 * Exposes business-level metrics via the /metrics endpoint:
 *   - Counters: swarm runs, agent spawns, tool calls, blocker events
 *   - Histograms: tool call duration, iteration count, roundtable duration
 *   - Gauges: active sessions, SSE subscribers
 *
 * Usage:
 *   import { metrics, recordHttpRequest } from "./metrics";
 *   metrics.swarmRunsTotal.inc({ status: "completed" });
 *   const end = metrics.toolCallDuration.startTimer({ tool: "bash" });
 *   // ... do work ...
 *   end();
 */

import { Counter, Histogram, Gauge, Registry, collectDefaultMetrics } from "prom-client";

// ── Custom registry (separate from default to control what /metrics exposes) ──

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "satopi_" });

// ── Counters ──────────────────────────────────────────────────────────────────

export const metrics = {
	/** Total swarm runs by outcome. */
	swarmRunsTotal: new Counter({
		name: "satopi_swarm_runs_total",
		help: "Total number of swarm runs",
		labelNames: ["status"] as const, // completed | failed | aborted
		registers: [registry],
	}),

	/** Total agent spawns by type and outcome. */
	agentSpawnsTotal: new Counter({
		name: "satopi_agent_spawns_total",
		help: "Total number of agent spawns",
		labelNames: ["agent_type", "outcome"] as const, // worker|cloner|socrates ; success|crash|timeout
		registers: [registry],
	}),

	/** Total tool calls by tool name and status. */
	toolCallsTotal: new Counter({
		name: "satopi_tool_calls_total",
		help: "Total number of tool calls",
		labelNames: ["tool", "status"] as const, // success | error | timeout
		registers: [registry],
	}),

	/** Blocker events by resolution. */
	blockerEventsTotal: new Counter({
		name: "satopi_blocker_events_total",
		help: "Blocker events requiring user intervention",
		labelNames: ["resolution"] as const, // auto_continue | user_skip | user_abort
		registers: [registry],
	}),

	/** HTTP requests by method, path, and status code. */
	httpRequestsTotal: new Counter({
		name: "satopi_http_requests_total",
		help: "Total HTTP requests",
		labelNames: ["method", "path", "status"] as const,
		registers: [registry],
	}),
};

// ── Histograms ────────────────────────────────────────────────────────────────

export const histograms = {
	/** Tool call duration in seconds. */
	toolCallDuration: new Histogram({
		name: "satopi_tool_call_duration_seconds",
		help: "Tool call duration in seconds",
		labelNames: ["tool"] as const,
		buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
		registers: [registry],
	}),

	/** Iterations per run. */
	iterationCount: new Histogram({
		name: "satopi_iteration_count",
		help: "Number of iterations per swarm run",
		buckets: [1, 2, 3, 5, 10, 20, 50],
		registers: [registry],
	}),

	/** Roundtable debate duration in seconds. */
	roundtableDuration: new Histogram({
		name: "satopi_roundtable_duration_seconds",
		help: "Roundtable debate duration",
		buckets: [1, 5, 10, 30, 60, 120, 300],
		registers: [registry],
	}),

	/** HTTP request duration in seconds. */
	httpRequestDuration: new Histogram({
		name: "satopi_http_request_duration_seconds",
		help: "HTTP request duration in seconds",
		labelNames: ["method", "path", "status"] as const,
		buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10],
		registers: [registry],
	}),
};

// ── Gauges ────────────────────────────────────────────────────────────────────

export const gauges = {
	/** Number of active swarm sessions. */
	activeSessions: new Gauge({
		name: "satopi_active_sessions",
		help: "Number of active swarm sessions",
		registers: [registry],
	}),

	/** Number of active SSE subscribers. */
	sseSubscribers: new Gauge({
		name: "satopi_sse_subscribers",
		help: "Number of active SSE subscribers",
		registers: [registry],
	}),

	/** Number of active workers across all sessions. */
	activeWorkers: new Gauge({
		name: "satopi_active_workers",
		help: "Number of currently running worker agents",
		registers: [registry],
	}),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Record an HTTP request's method, path, status, and duration.
 * Called from the server's fetch handler after each request completes.
 */
export function recordHttpRequest(
	method: string,
	pathname: string,
	status: number,
	durationMs: number,
): void {
	const labels = { method, path: normalizePath(pathname), status: String(status) };
	metrics.httpRequestsTotal.inc(labels);
	histograms.httpRequestDuration.observe(labels, durationMs / 1000);
}

/** Normalize paths with IDs to avoid cardinality explosion. */
function normalizePath(pathname: string): string {
	// Replace session names and run names with :param
	if (pathname.startsWith("/api/session/")) {
		const parts = pathname.slice("/api/session/".length).split("/");
		if (parts.length >= 2) return `/api/session/:name/${parts.slice(1).join("/")}`;
		return "/api/session/:name";
	}
	if (pathname.startsWith("/api/runs/")) {
		const rest = pathname.slice("/api/runs/".length);
		if (rest.includes("/activity")) return "/api/runs/:name/activity";
		return "/api/runs/:name";
	}
	if (pathname.startsWith("/api/roles/")) {
		const rest = pathname.slice("/api/roles/".length);
		if (rest.includes("/")) return "/api/roles/:id/:action";
		return "/api/roles/:id";
	}
	return pathname;
}

/** Get the Prometheus exposition format string for /metrics. */
export function getMetricsString(): string {
	return registry.metrics();
}

/** Get the content type for the Prometheus exposition format. */
export function getMetricsContentType(): string {
	return registry.contentType;
}
