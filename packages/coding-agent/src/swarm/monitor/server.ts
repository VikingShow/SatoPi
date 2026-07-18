/**
 * MonitorServer — Bun.serve() HTTP server with SSE + REST.
 *
 * Serves:
 *   GET  /            → SPA static files (from dist/ or dev proxy)
 *   GET  /api/state   → current SwarmState JSON
 *   GET  /api/config  → read loop.yaml
 *   PUT  /api/config  → write loop.yaml
 *   GET  /api/history → past activity entries
 *   GET  /api/runs    → list past swarm runs
 *   GET  /api/models  → available LLM models
 *   GET  /events      → SSE stream (real-time activity events)
 *
 * Only listens on 127.0.0.1 (localhost). Never exposed to network.
 */

import * as path from "node:path";
import type { ActivityBroadcaster, ActivityEntry } from "../activity-logger";
import type { StateTracker } from "../state";
import type { ExperienceStore } from "../after-loop/experience";
import type { RoleAssetManager } from "../role-asset";
import { EventBus } from "./event-bus";
import { apiRoutes, type ApiRouteContext, type RunManager, type BeforeLoopManager, type SteeringSink } from "./api-routes";

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
	#ctx: ApiRouteContext;

	constructor(
		stateTracker: StateTracker,
		workspaceDir: string,
		yamlPath: string,
		runManager?: RunManager,
		experienceStore?: ExperienceStore,
		beforeLoopManager?: BeforeLoopManager,
		steeringSink?: SteeringSink,
		modelRegistry?: import("../../config/model-registry").ModelRegistry,
		roleAssetManager?: RoleAssetManager,
	) {
		this.#ctx = {
			stateTracker,
			swarmDir: stateTracker.swarmDir,
			yamlPath,
			workspaceDir,
			runManager,
			experienceStore,
			beforeLoopManager,
			steeringSink,
			modelRegistry,
			roleAssetManager,
		};
	}

	/**
	 * Start the HTTP server.
	 *
	 * P4-2: Port resolution order:
	 *   1. PI_SWARM_PORT env var (if set and valid)
	 *   2. preferredPort caller argument
	 *   3. Falls back to DEFAULT_SWARM_PORT (7878)
	 *
	 * If the resolved port is taken, tries port+1, port+2, etc. up to 10 attempts.
	 * Returns the actual port used.
	 */
	start(preferredPort: number = DEFAULT_SWARM_PORT): number {
		let port = resolveSwarmPort(preferredPort);
		for (let attempt = 0; attempt < 10; attempt++) {
			try {
				this.#server = this.#createServer(port);
				return port;
			} catch (err) {
				if (String(err).includes("EADDRINUSE")) {
					port++;
					continue;
				}
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

	/** Push an activity entry to all SSE subscribers. */
	broadcast(entry: ActivityEntry): void {
		this.#bus.broadcast(entry);
	}

	get isRunning(): boolean {
		return this.#server !== null;
	}

	get port(): number | null {
		return this.#server?.port ?? null;
	}

	get subscriberCount(): number {
		return this.#bus.subscriberCount;
	}

	#createServer(port: number): ReturnType<typeof Bun.serve> {
		const ctx = this.#ctx;
		const bus = this.#bus;

		return Bun.serve({
			port,
			hostname: "0.0.0.0",
			development: false,
			async fetch(req): Promise<Response> {
				const url = new URL(req.url);
				const pathname = url.pathname;

				// -- SSE endpoint ------------------------------------------------
				if (pathname === "/events") {
					// P3-3: Read Last-Event-ID for reconnection state recovery.
					const lastEventId = req.headers.get("Last-Event-ID") ?? undefined;
					const stream = new ReadableStream({
						start(controller) {
							// Send connection confirmation with last event ID echo
							const handshake = lastEventId
								? `: connected\nid: ${lastEventId}\n\n`
								: ": connected\n\n";
							const hello = new TextEncoder().encode(handshake);
							controller.enqueue(hello);

							// Register subscriber
							const unsub = bus.subscribe(controller);

							// Cleanup on disconnect
							req.signal.addEventListener("abort", () => {
								unsub();
								try {
									controller.close();
								} catch {
									// already closed
								}
							});
						},
					});

					return new Response(stream, {
						headers: {
							"Content-Type": "text/event-stream",
							"Cache-Control": "no-cache",
							Connection: "keep-alive",
							"Access-Control-Allow-Origin": "*",
						},
					});
				}

				// -- REST API ----------------------------------------------------
				const method = req.method;
				const routeKey = `${method} ${pathname}`;

				// Try exact match first
				if (apiRoutes[routeKey]) {
					return apiRoutes[routeKey](req, ctx);
				}

			// Try pattern match (e.g., /api/runs/:name/activity)
			if (pathname.startsWith("/api/runs/") && method === "GET") {
				// Parse /api/runs/:name/activity or /api/runs/:name
				const rest = pathname.slice("/api/runs/".length);
				const parts = rest.split("/");
				const name = parts[0];
				const sub = parts[1]; // "activity" or undefined
				const routeKey = sub === "activity" ? "GET /api/runs/:name/activity" : "GET /api/runs/:name";
				return apiRoutes[routeKey]?.(req, { ...ctx, params: { name } }) ?? new Response("Not found", { status: 404 });
			}

			// Try pattern match for role routes (e.g., /api/roles/:id, /api/roles/:id/approve)
			if (pathname.startsWith("/api/roles/")) {
				const rest = pathname.slice("/api/roles/".length);
				const parts = rest.split("/");
				const id = parts[0];
				const action = parts[1]; // "approve" | "deprecate" | undefined
				let routeKey: string;
				if (action === "approve") {
					routeKey = "POST /api/roles/:id/approve";
				} else if (action === "deprecate") {
					routeKey = "POST /api/roles/:id/deprecate";
				} else if (!action) {
					routeKey = `${method} /api/roles/:id`;
				} else {
					return new Response("Not found", { status: 404 });
				}
				return apiRoutes[routeKey]?.(req, { ...ctx, params: { id } }) ?? new Response("Not found", { status: 404 });
			}

				// -- Static files (SPA) -----------------------------------------
				// In production, serve from dist/. In dev, Vite handles this.
				const distDir = path.resolve(import.meta.dir, "../../../../swarm-gui/dist");
				let filePath = pathname === "/" ? "/index.html" : pathname;
				const fullPath = path.join(distDir, filePath);

				try {
					const file = Bun.file(fullPath);
					if (await file.exists()) {
						return new Response(file);
					}
				} catch {
					// dist/ doesn't exist yet — dev mode
				}

				// Fallback: serve index.html for SPA routing
				try {
					const indexFile = Bun.file(path.join(distDir, "index.html"));
					if (await indexFile.exists()) {
						return new Response(indexFile);
					}
				} catch {
					// No dist yet
				}

				return new Response("Not found", { status: 404 });
			},
		});
	}
}
