/**
 * MonitorServer — Bun.serve() HTTP server with SSE + REST.
 *
 * Holds a SessionRegistry. Each request is routed to the correct session
 * via URL path: /api/session/{name}/... for session-scoped endpoints.
 * Global endpoints (/api/runs, /api/models, /api/roles, /api/experience)
 * and static SPA files are served directly.
 *
 * Observability endpoints:
 *   GET /metrics       — Prometheus exposition format
 *   GET /health        — Lightweight liveness probe
 *   GET /health/ready  — Readiness probe with dependency checks
 *
 * Only listens on 0.0.0.0.  Never exposed to network.
 */

import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ActivityBroadcaster, ActivityEntry } from "../activity-logger";
import { EventBus } from "./event-bus";
import { apiRoutes, type ApiRouteContext, buildApiRouteContext } from "./api-routes";
import type { SessionRegistry } from "../session-registry";
import { recordHttpRequest, getMetricsString, getMetricsContentType, gauges } from "./metrics";

/** P4-2: Default swarm monitor port. Override with PI_SWARM_PORT env var. */
const DEFAULT_SWARM_PORT = 7878;

function resolveSwarmPort(preferredPort: number): number {
	if (Bun.env.PI_SWARM_PORT) {
		const envPort = Number(Bun.env.PI_SWARM_PORT);
		if (Number.isFinite(envPort) && envPort > 0 && envPort <= 65535) return envPort;
	}
	return preferredPort;
}

export class MonitorServer implements ActivityBroadcaster {
	#server: ReturnType<typeof Bun.serve> | null = null;
	readonly #bus = new EventBus();
	#registry: SessionRegistry;

	constructor(registry: SessionRegistry) {
		this.#registry = registry;
	}

	start(preferredPort: number = DEFAULT_SWARM_PORT): number {
		let port = resolveSwarmPort(preferredPort);
		for (let attempt = 0; attempt < 10; attempt++) {
			try {
				this.#server = this.#createServer(port);
				return port;
			} catch (err) {
				if (String(err).includes("EADDRINUSE")) { port++; continue; }
				throw err;
			}
		}
		throw new Error(`Could not find available port starting from ${preferredPort}`);
	}

	stop(): void {
		this.#bus.closeAll();
		this.#server?.stop();
		this.#server = null;
	}

	/** Push an activity entry to subscribers of a specific session. */
	broadcast(sessionName: string, entry: ActivityEntry): void {
		this.#bus.broadcast(sessionName, entry);
	}

	get isRunning(): boolean { return this.#server !== null; }
	get port(): number | null { return this.#server?.port ?? null; }
	get subscriberCount(): number { return this.#bus.subscriberCount; }

	// ── Internal ─────────────────────────────────────────────────────────

	#createServer(port: number): ReturnType<typeof Bun.serve> {
		const bus = this.#bus;
		const registry = this.#registry;

		return Bun.serve({
			port,
			hostname: "0.0.0.0",
			development: false,
			async fetch(req): Promise<Response> {
				const url = new URL(req.url);
				const pathname = url.pathname;
				const method = req.method;
				const requestId = randomUUID();
				const startTime = performance.now();

				// Helper to record metrics after response is sent
				const finalize = (res: Response): Response => {
					const duration = performance.now() - startTime;
					recordHttpRequest(method, pathname, res.status, duration);
					res.headers.set("X-Request-Id", requestId);
					return res;
				};

				// ── Health & Metrics endpoints ─────────────────────────
				if (pathname === "/health" && method === "GET") {
					return finalize(new Response(
						JSON.stringify({ status: "ok", uptime: process.uptime() }),
						{ headers: { "Content-Type": "application/json" } },
					));
				}

				if (pathname === "/health/ready" && method === "GET") {
					const checks: Record<string, string> = {};
					// Verify session registry is functional (not the prom-client registry).
					try {
						const count = registry.activeCount;
						void count; // touch — throws only if the Map is broken
						checks.metrics = "ok";
					} catch { checks.metrics = "fail"; }
					checks.sessions = `${registry.activeCount} active`;
					checks.sseSubscribers = `${bus.subscriberCount} connected`;
					const allOk = Object.values(checks).every(v => v === "ok" || !v.includes("fail"));
					return finalize(new Response(
						JSON.stringify({ status: allOk ? "ready" : "degraded", checks }),
						{ status: allOk ? 200 : 503, headers: { "Content-Type": "application/json" } },
					));
				}

				if (pathname === "/metrics" && method === "GET") {
					// Update gauges before scraping
					gauges.activeSessions.set(registry.activeCount);
					gauges.sseSubscribers.set(bus.subscriberCount);
					const metricsBody = await getMetricsString();
					return finalize(new Response(metricsBody, {
						headers: { "Content-Type": getMetricsContentType() },
					}));
				}

				// ── SSE — per-session ───────────────────────────────────
				if (pathname === "/events") {
					const sessionName = url.searchParams.get("session") ?? undefined;
					// Resume support: native EventSource sends Last-Event-ID via
					// header on its OWN auto-reconnect, but our client performs
					// manual reconnection (new EventSource each time), which cannot
					// set custom headers — so it appends ?lastEventId=. Accept both.
					const lastEventId =
						url.searchParams.get("lastEventId") ?? req.headers.get("Last-Event-ID") ?? undefined;
					gauges.sseSubscribers.inc();
					const stream = new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(": connected\n\n"));
							// subscribe() replays any buffered entries with seq > lastEventId.
							const unsub = bus.subscribe(sessionName, controller, undefined, lastEventId);
							
							// SSE keepalive — prevents browser from closing the
							// connection during long model thinking phases.
							const keepalive = setInterval(() => {
								try { controller.enqueue(new TextEncoder().encode(": keepalive\n\n")); } catch { /* closed */ }
							}, 15_000);

							// Cleanup on disconnect
							/** @ts-expect-error — lib mismatch between Bun and DOM ReadableStream */
							req.signal.addEventListener("abort", () => {
								unsub();
								gauges.sseSubscribers.dec();
								try { controller.close(); } catch { /* closed */ }
							clearInterval(keepalive);
							});
						},
					});
					return new Response(stream, {
						headers: {
							"Content-Type": "text/event-stream",
							"Cache-Control": "no-cache",
							Connection: "keep-alive",
							"Access-Control-Allow-Origin": "*",
							"X-Request-Id": requestId,
						},
					});
				}

				// ── Session-scoped endpoints ────────────────────────────
				if (pathname.startsWith("/api/session/")) {
					const res = await handleSessionReq(req, pathname, method, registry, requestId);
					return finalize(res);
				}

				// ── Global endpoints ────────────────────────────────────
				const routeKey = `${method} ${pathname}`;

				// Exact match
				if (apiRoutes[routeKey]) {
					const ctx = buildApiRouteContext(registry);
					const res = await apiRoutes[routeKey](req, ctx);
					return finalize(res);
				}

				// Pattern: /api/runs/:name/activity or /api/runs/:name
				if (pathname.startsWith("/api/runs/") && method === "GET") {
					const rest = pathname.slice("/api/runs/".length);
					const parts = rest.split("/");
					const ctx = buildApiRouteContext(registry);
					const key = parts[1] === "activity"
						? "GET /api/runs/:name/activity"
						: "GET /api/runs/:name";
					const res = await apiRoutes[key]?.(req, { ...ctx, params: { name: parts[0] } })
						?? new Response("Not found", { status: 404 });
					return finalize(res);
				}

				// Pattern: /api/roles/:id, /api/roles/:id/approve, etc.
				if (pathname.startsWith("/api/roles/")) {
					const rest = pathname.slice("/api/roles/".length);
					const parts = rest.split("/");
					const id = parts[0];
					const action = parts[1];
					let key: string;
					if (action === "approve") key = "POST /api/roles/:id/approve";
					else if (action === "deprecate") key = "POST /api/roles/:id/deprecate";
					else if (!action) key = `${method} /api/roles/:id`;
					else return finalize(new Response("Not found", { status: 404 }));
					const ctx = buildApiRouteContext(registry);
					const res = await apiRoutes[key]?.(req, { ...ctx, params: { id } })
						?? new Response("Not found", { status: 404 });
					return finalize(res);
				}

				// ── Static SPA ──────────────────────────────────────────
				const distDir = path.resolve(import.meta.dir, "../../../../swarm-gui/dist");
				let filePath = pathname === "/" ? "/index.html" : pathname;
				const fullPath = path.join(distDir, filePath);

				// Try exact file
				try {
					const file = Bun.file(fullPath);
					if (await file.exists()) return finalize(new Response(file));
				} catch { /* dist/ missing — dev mode */ }

				// Fallback to index.html for SPA routing
				try {
					const indexFile = Bun.file(path.join(distDir, "index.html"));
					if (await indexFile.exists()) return finalize(new Response(indexFile));
				} catch { /* no dist yet */ }

				return finalize(new Response("Not found", { status: 404 }));
			},
		});
	}
}

// ── Session-scoped route handler ─────────────────────────────────────────

async function handleSessionReq(
	req: Request,
	pathname: string,
	method: string,
	registry: SessionRegistry,
	requestId: string,
): Promise<Response> {
	// pathname: /api/session/{name}/{rest...}
	const afterPrefix = pathname.slice("/api/session/".length);
	const slash = afterPrefix.indexOf("/");
	const sessionName = slash >= 0 ? afterPrefix.slice(0, slash) : afterPrefix;
	const subPath = slash >= 0 ? afterPrefix.slice(slash) : ""; // e.g. "/state", "/run/start"

	const session = registry.getSession(sessionName);
	if (!session) {
		return new Response(
			JSON.stringify({ error: { code: 404, message: `Session "${sessionName}" not found`, requestId } }),
			{ status: 404, headers: { "Content-Type": "application/json" } },
		);
	}

	const routeKey = `${method}${subPath}`; // e.g. "GET/state", "POST/run/start"

	const ctx = buildApiRouteContext(registry, session);
	if (apiRoutes[routeKey]) {
		return apiRoutes[routeKey](req, ctx);
	}
	return new Response(
		JSON.stringify({ error: { code: 404, message: "Not found", requestId } }),
		{ status: 404, headers: { "Content-Type": "application/json" } },
	);
}
