/**
 * API Routes — REST handlers for MonitorServer.
 *
 * Provides CRUD for loop.yaml config, state snapshots, and historical
 * activity log data. All routes return JSON responses.
 */

import * as path from "node:path";
import type { StateTracker } from "../state";
import type { ExperienceStore } from "../after-loop/experience";

/**
 * AfterLoopResult — shape returned by RunManager.getLastAfterLoopResult()
 * Import from standalone.ts to keep single source of truth.
 */
export interface AfterLoopResult {
  runId: string;
  status: string;
  iterations: number;
  summaryMarkdown: string;
  lessons: Array<{
    type: string;
    summary: string;
    detail: string;
    tags: string[];
    confidence: number;
    source: string;
  }>;
  reflection: {
    rootCauses: string[];
    effectivePatterns: string[];
    structuralIssues: string[];
    recommendations: string[];
    confidence: number;
  } | null;
  stats: {
    totalIterations: number;
    finalStatus: string;
    clonerApprovalRatio: number;
    workerCount: number;
    clonerCount: number;
  };
}

/**
 * RunManager — controls real swarm loop lifecycle.
 * Implemented by standalone.ts; injected into ApiRouteContext.
 */
export interface RunManager {
	start(): Promise<{ success: boolean; error?: string }>;
	stop(): Promise<{ success: boolean; error?: string }>;
	readonly isRunning: boolean;
	getLastAfterLoopResult?: () => AfterLoopResult | null;
	resolveBlocker?: (decision: "continue" | "skip" | "abort") => boolean;
}

/**
 * BeforeLoopManager — controls the Before Loop interactive planning phase.
 * Implemented by before-loop-manager.ts; injected into ApiRouteContext.
 */
export interface BeforeLoopManager {
	start(task: string): Promise<{ success: boolean; error?: string }>;
	sendMessage(text: string): Promise<{ success: boolean; error?: string }>;
	runDebate(): Promise<{ success: boolean; error?: string }>;
	confirm(): Promise<{ success: boolean; error?: string }>;
	cancel(): Promise<{ success: boolean; error?: string }>;
	getState(): { phase: string; task: string; conversationLength: number; planReady: boolean; busy: boolean };
	readonly isBusy: boolean;
}

/**
 * SteeringSink — accepts steering messages from the operator during a running loop.
 * The message is logged via ActivityLogger → SSE so it appears in the chat.
 */
export interface SteeringSink {
	steer(text: string): void;
}

export interface ApiRouteContext {
	stateTracker: StateTracker;
	swarmDir: string;
	yamlPath: string;
	workspaceDir: string;
	runManager?: RunManager;
	experienceStore?: ExperienceStore;
	beforeLoopManager?: BeforeLoopManager;
	steeringSink?: SteeringSink;
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

	// -- Plan (plan.md) ---------------------------------------------------
	"GET /api/plan": async (_req, ctx) => {
		const candidates = [
			path.join(ctx.workspaceDir, ".omp", "plan.md"),
			path.join(ctx.workspaceDir, "plan.md"),
			path.join(ctx.workspaceDir, ".swarm-workspace", ".omp", "plan.md"),
		];
		for (const p of candidates) {
			try {
				const content = await Bun.file(p).text();
				return json({ content, path: p });
			} catch {
				// try next
			}
		}
		return json({ content: "", error: "plan.md not found" }, 404);
	},

	"PUT /api/plan": async (req, ctx) => {
		try {
			const body = (await req.json()) as { content: string };
			const fs = await import("node:fs/promises");
			// Try existing plan path, default to .omp/plan.md
			let planPath = path.join(ctx.workspaceDir, ".omp", "plan.md");
			for (const p of [
				path.join(ctx.workspaceDir, ".omp", "plan.md"),
				path.join(ctx.workspaceDir, "plan.md"),
				path.join(ctx.workspaceDir, ".swarm-workspace", ".omp", "plan.md"),
			]) {
				try {
					await fs.access(p);
					planPath = p;
					break;
				} catch {
					// not found, try next
				}
			}
			await fs.mkdir(path.dirname(planPath), { recursive: true });
			await fs.writeFile(planPath, body.content, "utf-8");
			return json({ success: true, path: planPath });
		} catch (err) {
			return json({ error: String(err) }, 500);
		}
	},

	// -- Run control -----------------------------------------------------
	"POST /api/run/start": async (_req, ctx) => {
		if (!ctx.runManager) {
			return json({ error: "Run manager not available" }, 503);
		}
		if (ctx.runManager.isRunning) {
			return json({ error: "A swarm run is already in progress" }, 409);
		}
		const result = await ctx.runManager.start();
		return json(result, result.success ? 200 : 500);
	},

	"POST /api/run/stop": async (_req, ctx) => {
		if (!ctx.runManager) {
			return json({ error: "Run manager not available" }, 503);
		}
		const result = await ctx.runManager.stop();
		return json(result, result.success ? 200 : 500);
	},

	"GET /api/run/status": (_req, ctx) => {
		return json({
			running: ctx.runManager?.isRunning ?? false,
		});
	},

	// -- After Loop results ------------------------------------------------
	"GET /api/after-loop/summary": (_req, ctx) => {
		const result = ctx.runManager?.getLastAfterLoopResult?.();
		if (!result) {
			return json({ error: "No After Loop result available yet" }, 404);
		}
		return json(result);
	},

	// -- Experience store -------------------------------------------------
	"GET /api/experience": async (req, ctx) => {
		if (!ctx.experienceStore) {
			return json({ error: "Experience store not available" }, 503);
		}
		const url = new URL(req.url);
		const query = url.searchParams.get("q") ?? "";
		const limit = parseInt(url.searchParams.get("limit") ?? "10", 10);
		if (!query) {
			return json({ results: [] });
		}
		const results = ctx.experienceStore.search(query, limit);
		return json({ results });
	},

	"GET /api/experience/stats": async (_req, ctx) => {
		if (!ctx.experienceStore) {
			return json({ error: "Experience store not available" }, 503);
		}
		const stats = ctx.experienceStore.getAggregateStats();
		return json(stats);
	},

	"GET /api/experience/recent": async (req, ctx) => {
		if (!ctx.experienceStore) {
			return json({ error: "Experience store not available" }, 503);
		}
		const url = new URL(req.url);
		const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
		const lessons = ctx.experienceStore.getRecentLessons(limit);
		return json({ lessons });
	},

	// ── Before Loop (interactive planning) ─────────────────────────────────

	"POST /api/before-loop/start": async (req, ctx) => {
		if (!ctx.beforeLoopManager) {
			return json({ error: "Before Loop manager not available" }, 503);
		}
		if (ctx.runManager?.isRunning) {
			return json({ error: "A swarm run is already in progress" }, 409);
		}
		const body = (await req.json().catch(() => ({}))) as { task?: string };
		if (!body.task || body.task.trim().length === 0) {
			return json({ error: "Task description is required" }, 400);
		}
		const result = await ctx.beforeLoopManager.start(body.task);
		return json(result, result.success ? 200 : 500);
	},

	"POST /api/before-loop/message": async (req, ctx) => {
		if (!ctx.beforeLoopManager) {
			return json({ error: "Before Loop manager not available" }, 503);
		}
		const body = (await req.json().catch(() => ({}))) as { text?: string };
		if (!body.text || body.text.trim().length === 0) {
			return json({ error: "Message text is required" }, 400);
		}
		const result = await ctx.beforeLoopManager.sendMessage(body.text);
		return json(result, result.success ? 200 : 500);
	},

	"GET /api/before-loop/state": (_req, ctx) => {
		if (!ctx.beforeLoopManager) {
			return json({ error: "Before Loop manager not available" }, 503);
		}
		return json(ctx.beforeLoopManager.getState());
	},

	"POST /api/before-loop/debate": async (_req, ctx) => {
		if (!ctx.beforeLoopManager) {
			return json({ error: "Before Loop manager not available" }, 503);
		}
		const result = await ctx.beforeLoopManager.runDebate();
		return json(result, result.success ? 200 : 500);
	},

	"POST /api/before-loop/confirm": async (_req, ctx) => {
		if (!ctx.beforeLoopManager) {
			return json({ error: "Before Loop manager not available" }, 503);
		}
		const result = await ctx.beforeLoopManager.confirm();
		return json(result, result.success ? 200 : 500);
	},

	"POST /api/before-loop/cancel": async (_req, ctx) => {
		if (!ctx.beforeLoopManager) {
			return json({ error: "Before Loop manager not available" }, 503);
		}
		const result = await ctx.beforeLoopManager.cancel();
		return json(result, result.success ? 200 : 500);
	},

	// ── Steering (operator → running loop) ─────────────────────────────────

	"POST /api/run/steer": async (req, ctx) => {
		const body = (await req.json().catch(() => ({}))) as { text?: string };
		if (!body.text || body.text.trim().length === 0) {
			return json({ error: "Steering text is required" }, 400);
		}
		ctx.steeringSink?.steer(body.text);
		return json({ success: true });
	},

	// ── Blocker resolution (unblock a paused loop) ──────────────────────────

	"POST /api/run/resolve-blocker": async (req, ctx) => {
		if (!ctx.runManager?.resolveBlocker) {
			return json({ error: "Blocker resolution not available" }, 503);
		}
		const body = (await req.json().catch(() => ({}))) as { decision?: string };
		const validDecisions = ["continue", "skip", "abort"];
		if (!body.decision || !validDecisions.includes(body.decision)) {
			return json({ error: `Invalid decision. Must be one of: ${validDecisions.join(", ")}` }, 400);
		}
		const resolved = ctx.runManager.resolveBlocker(
			body.decision as "continue" | "skip" | "abort",
		);
		if (!resolved) {
			return json({ error: "No active blockage to resolve" }, 409);
		}
		return json({ success: true });
	},
};
