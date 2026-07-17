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
import { EventBus } from "./event-bus";
import { apiRoutes, type ApiRouteContext } from "./api-routes";

export class MonitorServer implements ActivityBroadcaster {
	#server: ReturnType<typeof Bun.serve> | null = null;
	readonly #bus = new EventBus();
	#ctx: ApiRouteContext;

	constructor(stateTracker: StateTracker, workspaceDir: string, yamlPath: string) {
		this.#ctx = {
			stateTracker,
			swarmDir: stateTracker.swarmDir,
			yamlPath,
			workspaceDir,
		};
	}

	/**
	 * Start the HTTP server on the given port.
	 * If port is taken, tries port+1, port+2, etc. up to 10 attempts.
	 * Returns the actual port used.
	 */
	start(preferredPort: number): number {
		let port = preferredPort;
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
			hostname: "127.0.0.1",
			development: false,
			async fetch(req): Promise<Response> {
				const url = new URL(req.url);
				const pathname = url.pathname;

				// -- SSE endpoint ------------------------------------------------
				if (pathname === "/events") {
					const stream = new ReadableStream({
						start(controller) {
							// Send initial connection confirmation
							const hello = new TextEncoder().encode(": connected\n\n");
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

				// Try pattern match (e.g., /api/runs/:name)
				if (pathname.startsWith("/api/runs/") && method === "GET") {
					return apiRoutes["GET /api/runs/:name"]?.(req, ctx) ?? new Response("Not found", { status: 404 });
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
