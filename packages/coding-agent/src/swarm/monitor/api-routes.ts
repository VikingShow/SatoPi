/**
 * API Routes — REST handlers for MonitorServer.
 *
 * Provides CRUD for loop.yaml config, state snapshots, and historical
 * activity log data. All routes return JSON responses.
 */

import * as path from "node:path";
import type { StateTracker } from "../state";

export interface ApiRouteContext {
	stateTracker: StateTracker;
	swarmDir: string;
	yamlPath: string;
	workspaceDir: string;
}

type RouteHandler = (req: Request, ctx: ApiRouteContext) => Response | Promise<Response>;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

async function readActivityLog(swarmDir: string): Promise<string[]> {
	const logPath = path.join(swarmDir, "activity.jsonl");
	try {
		const content = await Bun.file(logPath).text();
		return content.trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

export const apiRoutes: Record<string, RouteHandler> = {
	// -- State -----------------------------------------------------------
	"GET /api/state": (_req, ctx) => {
		return json(ctx.stateTracker.state);
	},

	// -- Config ----------------------------------------------------------
	"GET /api/config": async (_req, ctx) => {
		try {
			const content = await Bun.file(ctx.yamlPath).text();
			return json({ yaml: content });
		} catch {
			return json({ yaml: "", error: "Config file not found" }, 404);
		}
	},

	"PUT /api/config": async (req, ctx) => {
		try {
			const body = (await req.json()) as { yaml: string };
			await Bun.write(ctx.yamlPath, body.yaml);
			return json({ success: true });
		} catch (err) {
			return json({ error: String(err) }, 500);
		}
	},

	// -- History ---------------------------------------------------------
	"GET /api/history": async (_req, ctx) => {
		const lines = await readActivityLog(ctx.swarmDir);
		const entries = lines.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		}).filter(Boolean);
		return json({ entries });
	},

	// -- Runs ------------------------------------------------------------
	"GET /api/runs": async (_req, ctx) => {
		// List .swarm_* directories in workspace
		try {
			const fs = await import("node:fs/promises");
			const entries = await fs.readdir(ctx.workspaceDir);
			const swarms = entries
				.filter((e) => e.startsWith(".swarm_"))
				.map((e) => ({ name: e.replace(".swarm_", ""), dir: e }));
			return json({ runs: swarms });
		} catch {
			return json({ runs: [] });
		}
	},

	"GET /api/runs/:name": async (_req, ctx) => {
		const lines = await readActivityLog(ctx.swarmDir);
		return json({ entries: lines.length, logPath: path.join(ctx.swarmDir, "activity.jsonl") });
	},

	// -- Models ----------------------------------------------------------
	"GET /api/models": () => {
		return json({
			models: [
				{ id: "deepseek-chat", name: "DeepSeek Chat", tier: "worker" },
				{ id: "deepseek-reasoner", name: "DeepSeek Reasoner", tier: "cloner" },
				{ id: "gpt-4o", name: "GPT-4o", tier: "cloner" },
				{ id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", tier: "reviewer" },
			],
		});
	},
};
