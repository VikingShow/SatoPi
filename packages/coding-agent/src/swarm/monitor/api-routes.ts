/**
 * API Routes — REST handlers for MonitorServer.
 *
 * Provides CRUD for loop.yaml config, state snapshots, and historical
 * activity log data. All routes return JSON responses.
 */

import * as path from "node:path";
import type { StateTracker } from "../state";
import type { ExperienceStore } from "../after-loop/experience";
import type { ModelRegistry } from "../../config/model-registry";
import type { RoleAssetManager } from "../role-asset";
import type { AfterLoopResult } from "./types";

export type { AfterLoopResult };

/**
 * RunManager — controls real swarm loop lifecycle.
 * Implemented by standalone.ts; injected into ApiRouteContext.
 */
export interface RunManager {
	start(): Promise<{ success: boolean; error?: string }>;
	stop(): Promise<{ success: boolean; error?: string }>;
	pause(): Promise<{ success: boolean; error?: string }>;
	resume(): Promise<{ success: boolean; error?: string }>;
	updatePlanAndContinue(content: string): Promise<{ success: boolean; error?: string }>;
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
	getHistory(): Array<{ role: "user" | "assistant"; content: string }>;
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
	/** Model registry — used to advertise actually-available models to the UI. */
	modelRegistry?: ModelRegistry;
	/** Role asset manager — manages role YAML files. */
	roleAssetManager?: RoleAssetManager;
	/** URL path parameters (e.g. :name in /api/runs/:name) */
	params?: Record<string, string>;
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
	// ── Role Asset Library ──────────────────────────────────────────────────

	"GET /api/roles": (req, ctx) => {
		if (!ctx.roleAssetManager) {
			return json({ error: "Role asset manager not available" }, 503);
		}
		const url = new URL(req.url);
		const status = url.searchParams.get("status") as
			| import("../role-asset").RoleStatus
			| null;
		const tag = url.searchParams.get("tag") ?? undefined;
		const q = url.searchParams.get("q") ?? undefined;

		// If search params are provided, use search endpoint logic
		if (tag || q || status) {
			return ctx.roleAssetManager
				.search({ tag, status: status ?? undefined, q })
				.then((roles) => json({ roles }));
		}
		return ctx.roleAssetManager.list(status ?? undefined).then((roles) => json({ roles }));
	},

	"GET /api/roles/:id": (req, ctx) => {
		if (!ctx.roleAssetManager) {
			return json({ error: "Role asset manager not available" }, 503);
		}
		const id = ctx.params?.id;
		if (!id) return json({ error: "Missing role ID" }, 400);
		return ctx.roleAssetManager.get(id).then((role) => {
			if (!role) return json({ error: "Role not found" }, 404);
			return json(role);
		});
	},

	"POST /api/roles": async (req, ctx) => {
		if (!ctx.roleAssetManager) {
			return json({ error: "Role asset manager not available" }, 503);
		}
		try {
			const body = (await req.json()) as import("../role-asset").RoleCreateInput;
			if (!body.id || !body.name || !body.prompts) {
				return json({ error: "Missing required fields: id, name, prompts" }, 400);
			}
			const role = await ctx.roleAssetManager.create(body);
			return json(role, 201);
		} catch (err) {
			return json({ error: String(err) }, 409);
		}
	},

	"PUT /api/roles/:id": async (req, ctx) => {
		if (!ctx.roleAssetManager) {
			return json({ error: "Role asset manager not available" }, 503);
		}
		const id = ctx.params?.id;
		if (!id) return json({ error: "Missing role ID" }, 400);
		try {
			const body = (await req.json()) as import("../role-asset").RoleUpdateInput;
			const role = await ctx.roleAssetManager.update(id, body);
			return json(role);
		} catch (err) {
			const msg = String(err);
			if (msg.includes("not found")) return json({ error: msg }, 404);
			return json({ error: msg }, 500);
		}
	},

	"POST /api/roles/:id/approve": async (_req, ctx) => {
		if (!ctx.roleAssetManager) {
			return json({ error: "Role asset manager not available" }, 503);
		}
		const id = ctx.params?.id;
		if (!id) return json({ error: "Missing role ID" }, 400);
		try {
			const role = await ctx.roleAssetManager.approve(id);
			return json(role);
		} catch (err) {
			const msg = String(err);
			if (msg.includes("not found")) return json({ error: msg }, 404);
			return json({ error: msg }, 400);
		}
	},

	"POST /api/roles/:id/deprecate": async (_req, ctx) => {
		if (!ctx.roleAssetManager) {
			return json({ error: "Role asset manager not available" }, 503);
		}
		const id = ctx.params?.id;
		if (!id) return json({ error: "Missing role ID" }, 400);
		try {
			const role = await ctx.roleAssetManager.deprecate(id);
			return json(role);
		} catch (err) {
			const msg = String(err);
			if (msg.includes("not found")) return json({ error: msg }, 404);
			return json({ error: msg }, 500);
		}
	},

	"DELETE /api/roles/:id": async (_req, ctx) => {
		if (!ctx.roleAssetManager) {
			return json({ error: "Role asset manager not available" }, 503);
		}
		const id = ctx.params?.id;
		if (!id) return json({ error: "Missing role ID" }, 400);
		try {
			const deleted = await ctx.roleAssetManager.delete(id);
			if (!deleted) return json({ error: "Role not found" }, 404);
			return json({ success: true });
		} catch (err) {
			return json({ error: String(err) }, 500);
		}
	},

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
	"GET /api/history": async (req, ctx) => {
		// P3-3: Support ?since=<timestamp> for incremental history fetch after reconnect.
		const url = new URL(req.url);
		const sinceParam = url.searchParams.get("since");
		const since = sinceParam ? Number(sinceParam) : 0;
		const lines = await readActivityLog(ctx.swarmDir);
		const entries = lines
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter((e): e is Record<string, unknown> => e !== null)
			.filter((e) => !since || (typeof e.ts === "number" && e.ts > since));
		return json({ entries });
	},

	// -- Runs ------------------------------------------------------------
	"GET /api/runs": async (_req, ctx) => {
		// List .swarm_* directories in workspace with rich metadata
		try {
			const fs = await import("node:fs/promises");
			const entries = await fs.readdir(ctx.workspaceDir);
			const swarms = entries.filter((e) => e.startsWith(".swarm_"));
			const runs = await Promise.all(
				swarms.map(async (dir) => {
					const name = dir.replace(".swarm_", "");
					const swarmDir = path.join(ctx.workspaceDir, dir);
					let lastActivity: string | null = null;
					let messageCount = 0;
					let status: "idle" | "running" | "completed" | "failed" = "idle";
					try {
						const statePath = path.join(swarmDir, "state", "pipeline.json");
						const stateContent = await Bun.file(statePath).text();
						const st = JSON.parse(stateContent) as { status?: string; startedAt?: number; completedAt?: number; loopPhase?: string };
						status = (st.status as typeof status) ?? "idle";
						if (st.completedAt) lastActivity = new Date(st.completedAt).toISOString();
						else if (st.startedAt) lastActivity = new Date(st.startedAt).toISOString();
					} catch {
						// state file might not exist
					}
					try {
						const logPath = path.join(swarmDir, "activity.jsonl");
						const logContent = await Bun.file(logPath).text();
						messageCount = logContent.trim().split("\n").filter(Boolean).length;
					} catch {
						// log might not exist
					}
					return { name, dir, lastActivity, messageCount, status };
				}),
			);
			// Sort by lastActivity desc (most recent first)
			runs.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
			return json({ runs });
		} catch {
			return json({ runs: [] });
		}
	},

	"GET /api/runs/:name/activity": async (_req, ctx) => {
		// Load activity log for a specific historical run
		const name = ctx.params?.name;
		if (!name) {
			return json({ error: "Missing run name" }, 400);
		}
		const swarmDir = path.join(ctx.workspaceDir, `.swarm_${name}`);
		const lines = await readActivityLog(swarmDir);
		const entries = lines.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		}).filter(Boolean);
		return json({ entries });
	},

	"GET /api/runs/:name": async (_req, ctx) => {
		// Metadata-only for a specific run (used by session switcher to confirm exists)
		const name = ctx.params?.name;
		if (!name) {
			return json({ error: "Missing run name" }, 400);
		}
		const swarmDir = path.join(ctx.workspaceDir, `.swarm_${name}`);
		const lines = await readActivityLog(swarmDir);
		return json({ name, dir: `.swarm_${name}`, messageCount: lines.length });
	},

	// -- Models ----------------------------------------------------------
	"GET /api/models": (_req, ctx) => {
		// Dynamically list models that have auth configured so the Settings UI
		// can only pick models the user can actually call. Falls back to a
		// minimal known-good list when the registry is not yet wired in.
		if (!ctx.modelRegistry) {
			return json({
				models: [
					{ id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek", tier: "worker" },
				],
				warning: "ModelRegistry not available; returning fallback list",
			});
		}
		const available = ctx.modelRegistry.getAvailable();
		// Surface every model the user can authenticate to, grouping by provider.
		// Tier is a soft default — the UI may override per-role in the YAML.
		const models = available.map((m) => ({
			id: `${m.provider}/${m.id}`,
			name: m.name ?? m.id,
			provider: m.provider,
			tier: m.id.toLowerCase().includes("reasoner") || m.id.toLowerCase().includes("pro")
				? "cloner"
				: m.id.toLowerCase().includes("sonnet") || m.id.toLowerCase().includes("opus")
				? "reviewer"
				: "worker",
		}));
		return json({ models });
	},

	// -- Plan (plan.md) — per-session: {swarmDir}/.omp/plan.md
	// Each session has its own plan.md, archives are workspace-scoped.
	"GET /api/plan": async (_req, ctx) => {
		const planPath = path.join(ctx.swarmDir, ".omp", "plan.md");
		try {
			const content = await Bun.file(planPath).text();
			return json({ content, path: planPath });
		} catch {
			return json({ content: "", path: planPath, error: "plan.md not found" });
		}
	},

	"PUT /api/plan": async (req, ctx) => {
		try {
			const body = (await req.json()) as { content: string };
			const fs = await import("node:fs/promises");
			const planPath = path.join(ctx.swarmDir, ".omp", "plan.md");
			await fs.mkdir(path.dirname(planPath), { recursive: true });
			await fs.writeFile(planPath, body.content, "utf-8");
			return json({ success: true, path: planPath });
		} catch (err) {
			return json({ error: String(err) }, 500);
		}
	},

	// -- Plan Todos (parsed from plan.md, tracked during loop) --------------
	"GET /api/plan/todos": (_req, ctx) => {
		return json({ todos: ctx.stateTracker.state.todos ?? [] });
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

	"POST /api/run/pause": async (_req, ctx) => {
		if (!ctx.runManager) {
			return json({ error: "Run manager not available" }, 503);
		}
		const result = await ctx.runManager.pause();
		return json(result, result.success ? 200 : 500);
	},

	"POST /api/run/resume": async (_req, ctx) => {
		if (!ctx.runManager) {
			return json({ error: "Run manager not available" }, 503);
		}
		const result = await ctx.runManager.resume();
		return json(result, result.success ? 200 : 500);
	},

	"POST /api/plan/update-and-continue": async (req, ctx) => {
		if (!ctx.runManager) {
			return json({ error: "Run manager not available" }, 503);
		}
		const body = (await req.json().catch(() => ({}))) as { content?: string };
		if (!body.content || body.content.trim().length === 0) {
			return json({ error: "Plan content is required" }, 400);
		}
		const result = await ctx.runManager.updatePlanAndContinue(body.content);
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
			return json({ error: "No After Loop result available yet" });
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

	"GET /api/before-loop/history": (_req, ctx) => {
		if (!ctx.beforeLoopManager) {
			return json({ error: "Before Loop manager not available" }, 503);
		}
		return json({ history: ctx.beforeLoopManager.getHistory() });
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

	// ── Terminal (xterm.js) ──────────────────────────────────────────────
	"GET /api/terminal/connect": (_req, _ctx) => {
		const shell = Bun.spawn(["bash", "--norc"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			cwd: _ctx.workspaceDir ?? process.cwd(),
			env: { ...process.env, TERM: "xterm-256color", HOME: process.env.HOME ?? "/root" },
		});

		const stream = new ReadableStream({
			async start(controller) {
				const encoder = new TextEncoder();
				const write = (data: string) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "output", data })}\n\n`));

				try {
					const stdoutReader = shell.stdout.getReader();
					const stderrReader = shell.stderr.getReader();

					const readLoop = async (reader: ReadableStreamDefaultReader<Uint8Array>, label: string) => {
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							const text = new TextDecoder().decode(value);
							write(text);
						}
						if (label === "stdout") {
							try { shell.kill(); } catch {}
							controller.close();
						}
					};

					readLoop(stdoutReader, "stdout");
					readLoop(stderrReader, "stderr");
				} catch {
					controller.close();
				}
			},
			cancel() {
				try { shell.kill(); } catch {}
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
	},

	"POST /api/terminal/input": async (req, _ctx) => {
		const body = (await req.json().catch(() => ({}))) as { input?: string };
		if (!body.input) {
			return json({ error: "Missing input" }, 400);
		}
		// Input is handled via GET /api/terminal/connect SSE — this endpoint
		// provides a request-response interface for sending commands.
		// In the current architecture, the shell runs per-SSE-connection.
		// For a simpler approach, execute the command directly and return output.
		try {
			const proc = Bun.spawn(["bash", "-c", body.input], {
				stdout: "pipe",
				stderr: "pipe",
				cwd: _ctx.workspaceDir ?? process.cwd(),
			});
			const output = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			await proc.exited;
			return json({ output, stderr, exitCode: proc.exitCode });
		} catch (err) {
			return json({ error: String(err) }, 500);
		}
	},
};
