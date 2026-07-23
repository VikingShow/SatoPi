/**
 * API Routes — REST handlers for MonitorServer.
 *
 * Routes are partitioned into two groups:
 *   1. Session-scoped — dispatched by /api/session/{name}/...
 *      Route key format: "METHOD/path" (e.g. "GET/state", "POST/run/start")
 *   2. Global — dispatched by their full path (e.g. "GET /api/runs")
 *
 * Each request receives an ApiRouteContext populated with the correct
 * session's paths, state, and services (or shared services for global
 * endpoints).
 */

import * as path from "node:path";
import type { StateTracker } from "../state";
import type { ExperienceStore } from "../after-loop/experience";
import type { ModelRegistry } from "../../config/model-registry";
import type { RoleAssetManager } from "../role-asset";
import type { AfterLoopResult } from "./types";
import type { SessionRegistry, SessionServices, SharedServices } from "../session-registry";
import { SwarmSessionManager } from "../swarm-session-manager";

export type { AfterLoopResult };

// ============================================================================
// Service interfaces — defined here, implemented externally
// ============================================================================

/** Controls the swarm loop lifecycle.  Implemented by SwarmRunManager. */
export interface RunManager {
		setSessionManager?(sm: import("../swarm-session-manager").SwarmSessionManager): void;
	start(): Promise<{ success: boolean; error?: string }>;
	stop(): Promise<{ success: boolean; error?: string }>;
	pause(): Promise<{ success: boolean; error?: string }>;
	resume(): Promise<{ success: boolean; error?: string }>;
	updatePlanAndContinue(content: string): Promise<{ success: boolean; error?: string }>;
	readonly isRunning: boolean;
	getLastAfterLoopResult?: () => AfterLoopResult | null;
	resolveBlocker?: (decision: "continue" | "skip" | "abort") => boolean;
}

/** Manages the Script (planning) phase. */
export interface ScriptManager {
	setSessionManager?(sm: SwarmSessionManager): void;
	start(task: string, agentId?: string): Promise<{ success: boolean; error?: string }>;
	sendMessage(text: string): Promise<{ success: boolean; error?: string }>;
	runDebate(): Promise<{ success: boolean; error?: string }>;
	confirm(workerCount?: number, clonerCount?: number): Promise<{ success: boolean; error?: string }>;
	cancel(): Promise<{ success: boolean; error?: string }>;
	getState(): {
		phase: string; task: string; conversationLength: number;
		planReady: boolean; busy: boolean;
		selectedAgentId?: string; recommendedAgents?: number;
		estimatedAgentHours?: number; estimatedAgentHours?: number;
	};
	getHistory(): Array<{ role: "user" | "assistant"; content: string }>;
	readonly isBusy: boolean;
}

/** Accepts steering messages from the operator during a running loop. */
export interface SteeringSink {
	steer(text: string): void;
}

// ============================================================================
// Context — per-request bag
// ============================================================================

export interface ApiRouteContext {
		/** The session registry (for create/destroy endpoints). */
		registry: SessionRegistry;
	/** File-system paths for the resolved session. */
	paths: {
		swarmDir: string;
		workspaceDir: string;
		yamlPath: string;
	};
	/** Core state tracker (always present). */
	stateTracker: StateTracker;
	/** Services — populated from the session or from shared services. */
	services: {
		runManager?: RunManager;
		scriptManager?: ScriptManager;
		steeringSink?: SteeringSink;
		experienceStore?: ExperienceStore;
		modelRegistry?: ModelRegistry;
		roleAssetManager?: RoleAssetManager;
		sessionManager?: SwarmSessionManager;
	};
	/** URL path parameters extracted by the router. */
	params: Record<string, string>;
}

type RouteHandler = (req: Request, ctx: ApiRouteContext) => Response | Promise<Response>;

// ============================================================================
// Context builder
// ============================================================================

/**
 * Build an ApiRouteContext for the active session or for shared services only.
 *
 * When `session` is provided, paths and per-session services come from the
 * session; shared services come from the registry.  When `session` is
 * omitted, all services come from shared (e.g. for global endpoints).
 */
export function buildApiRouteContext(
	registry: SessionRegistry,
	session?: SessionServices,
): ApiRouteContext {
	const shared = registry.shared;

	const paths = {
		swarmDir: session?.swarmDir ?? shared.workspace,
		workspaceDir: shared.workspace,
		yamlPath: shared.yamlPath,
	};

	const services: ApiRouteContext["services"] = {
		modelRegistry: shared.modelRegistry,
		experienceStore: shared.experienceStore,
		roleAssetManager: shared.roleAssetManager,
		runManager: session?.runManager,
		scriptManager: session?.scriptManager,
		steeringSink: session?.steeringSink,
		sessionManager: session?.sessionManager,
	};

	return {
		registry,
		paths,
		stateTracker: session?.stateTracker as StateTracker,
		services,
		params: {},
	};
}

// ============================================================================
// Helpers
// ============================================================================

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/**
 * Read activity entries from session.jsonl for a given swarm directory.
 * Returns serialised JSON lines (mirroring the old activity.jsonl format
 * so existing frontend code continues to work unchanged).
 */
async function readActivityLog(swarmDir: string): Promise<string[]> {
	const entries = await SwarmSessionManager.readActivityEntries(swarmDir);
	return entries.map(e => JSON.stringify(e));
}

// ============================================================================
// Route table — session-scoped keys are "METHOD/path", global are "METHOD /path"
// ============================================================================

export const apiRoutes: Record<string, RouteHandler> = {
	// ══════════════════════════════════════════════════════════════════════
	// Session-scoped endpoints — dispatched via /api/session/{name}/...
	// Route key format: "METHOD/subPath" (e.g. "GET/state", "POST/run/start")
	// ══════════════════════════════════════════════════════════════════════

	// -- State -----------------------------------------------------------
	"GET/state": (_req, ctx) => {
		return json(ctx.stateTracker.state);
	},

	// -- Config ----------------------------------------------------------
	"GET/config": async (_req, ctx) => {
		try {
			const content = await Bun.file(ctx.paths.yamlPath).text();
			return json({ yaml: content });
		} catch {
			return json({ yaml: "", error: "Config file not found" }, 404);
		}
	},

	"PUT/config": async (req, ctx) => {
		try {
			const body = (await req.json()) as { yaml: string };
			await Bun.write(ctx.paths.yamlPath, body.yaml);
			return json({ success: true });
		} catch (err) {
			return json({ error: String(err) }, 500);
		}
	},

	// -- History ---------------------------------------------------------
	"GET/history": async (req, ctx) => {
		const url = new URL(req.url);
		const sinceParam = url.searchParams.get("since");
		const since = sinceParam ? Number(sinceParam) : 0;
		const lines = await readActivityLog(ctx.paths.swarmDir);
		const entries = lines
			.map((line) => {
				try { return JSON.parse(line); } catch { return null; }
			})
			.filter((e): e is Record<string, unknown> => e !== null)
			.filter((e) => !since || (typeof e.ts === "number" && e.ts > since));
		return json({ entries });
	},


		// -- Session tree (session-scoped) ------------------------------------
		"GET/tree": async (_req, ctx) => {
			if (!ctx.services.sessionManager) return json({ error: "Session manager not available" }, 503);
			const tree = ctx.services.sessionManager.getTree();
			return json({ tree });
		},

	// -- Plan (plan.md) — per-session: {swarmDir}/.omp/plan.md -----------
	"GET/plan": async (_req, ctx) => {
		const planPath = path.join(ctx.paths.swarmDir, ".omp", "plan.md");
		try {
			const content = await Bun.file(planPath).text();
			return json({ content, path: planPath });
		} catch {
			return json({ content: "", path: planPath, error: "plan.md not found" });
		}
	},

	"PUT/plan": async (req, ctx) => {
		try {
			const body = (await req.json()) as { content: string };
			const fs = await import("node:fs/promises");
			const planPath = path.join(ctx.paths.swarmDir, ".omp", "plan.md");
			await fs.mkdir(path.dirname(planPath), { recursive: true });
			await fs.writeFile(planPath, body.content, "utf-8");
			return json({ success: true, path: planPath });
		} catch (err) {
			return json({ error: String(err) }, 500);
		}
	},

	// -- Plan Todos ------------------------------------------------------
	"GET/plan/todos": (_req, ctx) => {
		return json({ todos: ctx.stateTracker.state.todos ?? [] });
	},


		// -- Agents (profile listing for agent selector) --------------------
		"GET/script/agents": (_req, ctx) => {
			const profileRegistry = ctx.registry.shared.profileRegistry;
			const profiles = profileRegistry.list();
			const agents = profiles.map(p => ({
				profileId: p.profileId,
				name: p.identity.name,
				archetype: p.identity.archetype,
				score: p.credit.score,
				domains: p.expertise.domains,
				totalTasks: p.credit.totalTasks,
				successRate: p.credit.successRate,
				preferredRoles: p.stats.preferredRoles,
				recommended: p.stats.rolePerformance["planner"]
					? p.stats.rolePerformance["planner"].successRate >= 0.7 && p.stats.rolePerformance["planner"].tasks >= 2
					: p.credit.score >= 70,
			}));
			agents.sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0) || b.score - a.score);
			return json({ agents });
		},

	// -- Run control -----------------------------------------------------
	"POST/run/start": async (_req, ctx) => {
		if (!ctx.services.runManager) {
			return json({ error: "Run manager not available" }, 503);
		}
		if (ctx.services.runManager.isRunning) {
			return json({ error: "A swarm run is already in progress" }, 409);
		}
		// Guard: the only valid entry point for starting a run is
		// POST /script/confirm (via the BeforeLoop flow).
		return json({ error: "Use the Before Loop flow to start a run. Direct /run/start is not allowed." }, 400);
	},

	"POST/run/stop": async (_req, ctx) => {
		if (!ctx.services.runManager) return json({ error: "Run manager not available" }, 503);
		const result = await ctx.services.runManager.stop();
		return json(result, result.success ? 200 : 409);
	},

	"POST/run/pause": async (_req, ctx) => {
		if (!ctx.services.runManager) return json({ error: "Run manager not available" }, 503);
		const result = await ctx.services.runManager.pause();
		return json(result, result.success ? 200 : 500);
	},

	"POST/run/resume": async (_req, ctx) => {
		if (!ctx.services.runManager) return json({ error: "Run manager not available" }, 503);
		const result = await ctx.services.runManager.resume();
		return json(result, result.success ? 200 : 500);
	},

	"POST/plan/update-and-continue": async (req, ctx) => {
		if (!ctx.services.runManager) return json({ error: "Run manager not available" }, 503);
		const body = (await req.json().catch(() => ({}))) as { content?: string };
		if (!body.content || body.content.trim().length === 0) {
			return json({ error: "Plan content is required" }, 400);
		}
		const result = await ctx.services.runManager.updatePlanAndContinue(body.content);
		return json(result, result.success ? 200 : 500);
	},

	"GET/run/status": (_req, ctx) => {
		return json({ running: ctx.services.runManager?.isRunning ?? false });
	},

	// -- After Loop results ----------------------------------------------
	"GET/curtain/summary": (_req, ctx) => {
		const result = ctx.services.runManager?.getLastAfterLoopResult?.();
		if (!result) return json({ error: "No After Loop result available yet" });
		return json(result);
	},

	// -- Before Loop (interactive planning) ------------------------------
	"POST/script/start": async (req, ctx) => {
		if (!ctx.services.scriptManager) return json({ error: "Script manager not available" }, 503);
		if (ctx.services.runManager?.isRunning) return json({ error: "A swarm run is already in progress" }, 409);
		const body = (await req.json().catch(() => ({}))) as { task?: string; agentId?: string };
		if (!body.task || body.task.trim().length === 0) {
			return json({ error: "Task description is required" }, 400);
		}
		const result = await ctx.services.scriptManager.start(body.task, body.agentId);
		return json(result, result.success ? 200 : 500);
	},

	"POST/script/message": async (req, ctx) => {
		if (!ctx.services.scriptManager) return json({ error: "Script manager not available" }, 503);
		const body = (await req.json().catch(() => ({}))) as { text?: string };
		if (!body.text || body.text.trim().length === 0) {
			return json({ error: "Message text is required" }, 400);
		}
		const result = await ctx.services.scriptManager.sendMessage(body.text);
		return json(result, result.success ? 200 : 500);
	},

	"GET/script/state": (_req, ctx) => {
		if (!ctx.services.scriptManager) return json({ error: "Before Loop manager not available" }, 503);
		return json(ctx.services.scriptManager.getState());
	},

	"GET/script/history": (_req, ctx) => {
		if (!ctx.services.scriptManager) return json({ error: "Before Loop manager not available" }, 503);
		return json({ history: ctx.services.scriptManager.getHistory() });
	},

	"POST/script/debate": async (_req, ctx) => {
		if (!ctx.services.scriptManager) return json({ error: "Before Loop manager not available" }, 503);
		const result = await ctx.services.scriptManager.runDebate();
		return json(result, result.success ? 200 : 500);
	},

	"POST/script/confirm": async (req, ctx) => {
		if (!ctx.services.scriptManager) return json({ error: "Before Loop manager not available" }, 503);
		const body = (await req.json().catch(() => ({}))) as {
			workerCount?: number;
			clonerCount?: number;
		};
		const result = await ctx.services.scriptManager.confirm(
			body.workerCount,
			body.clonerCount,
		);
		return json(result, result.success ? 200 : 500);
	},

	"POST/script/cancel": async (_req, ctx) => {
		if (!ctx.services.scriptManager) return json({ error: "Before Loop manager not available" }, 503);
		const result = await ctx.services.scriptManager.cancel();
		return json(result, result.success ? 200 : 500);
	},

	// -- Steering (operator → running loop) ------------------------------
	"POST/run/steer": async (req, ctx) => {
		const body = (await req.json().catch(() => ({}))) as { text?: string };
		if (!body.text || body.text.trim().length === 0) {
			return json({ error: "Steering text is required" }, 400);
		}
		ctx.services.steeringSink?.steer(body.text);
		return json({ success: true });
	},

	// -- Blocker resolution ----------------------------------------------
	"POST/run/resolve-blocker": async (req, ctx) => {
		if (!ctx.services.runManager?.resolveBlocker) {
			return json({ error: "Blocker resolution not available" }, 503);
		}
		const body = (await req.json().catch(() => ({}))) as { decision?: string };
		const validDecisions = ["continue", "skip", "abort"];
		if (!body.decision || !validDecisions.includes(body.decision)) {
			return json({ error: `Invalid decision. Must be one of: ${validDecisions.join(", ")}` }, 400);
		}
		const resolved = ctx.services.runManager.resolveBlocker(body.decision as "continue" | "skip" | "abort");
		if (!resolved) return json({ error: "No active blockage to resolve" }, 409);
		return json({ success: true });

		// -- Applaud (Curtain phase confirmation) ------------------------------
		"POST/curtain/applaud": async (_req, ctx) => {
			if (!ctx.services.runManager) return json({ error: "Run manager not available" }, 503);
			await ctx.stateTracker.updatePipeline({ phase: "idle", status: "completed" });
			ctx.services.sessionManager?.logPhase("idle");
			return json({ success: true, message: "Bravo! The curtain has fallen." });
		},
	},

	// -- Terminal (xterm.js) ---------------------------------------------
	"GET/terminal/connect": (_req, _ctx) => {
		const shell = Bun.spawn(["bash", "--norc"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			cwd: _ctx.paths.swarmDir || process.cwd(),
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
						if (label === "stdout") { try { shell.kill(); } catch {}; controller.close(); }
					};

					// @ts-expect-error — Bun's ReadableStreamDefaultReader lacks the spec `readMany` method
					readLoop(stdoutReader, "stdout");
					// @ts-expect-error — Bun's ReadableStreamDefaultReader lacks the spec `readMany` method
					readLoop(stderrReader, "stderr");
				} catch { controller.close(); }
			},
			cancel() { try { shell.kill(); } catch {}; },
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

	"POST/terminal/input": async (req, _ctx) => {
		const body = (await req.json().catch(() => ({}))) as { input?: string };
		if (!body.input) return json({ error: "Missing input" }, 400);
		try {
			const proc = Bun.spawn(["bash", "-c", body.input], {
				stdout: "pipe",
				stderr: "pipe",
				cwd: _ctx.paths.swarmDir || process.cwd(),
			});
			const output = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			await proc.exited;
			return json({ output, stderr, exitCode: proc.exitCode });
		} catch (err) {
			return json({ error: String(err) }, 500);
		}
	},

	// ══════════════════════════════════════════════════════════════════════
	// Global (non-session) endpoints — dispatched directly
	// Route key format: "METHOD /path"
	// ══════════════════════════════════════════════════════════════════════

	// -- Role Asset Library ----------------------------------------------
	"GET /api/roles": (req, ctx) => {
		if (!ctx.services.roleAssetManager) return json({ error: "Role asset manager not available" }, 503);
		const url = new URL(req.url);
		const status = url.searchParams.get("status") as import("../role-asset").RoleStatus | null;
		const tag = url.searchParams.get("tag") ?? undefined;
		const q = url.searchParams.get("q") ?? undefined;
		if (tag || q || status) {
			return ctx.services.roleAssetManager.search({ tag, status: status ?? undefined, q })
				.then((roles) => json({ roles }));
		}
		return ctx.services.roleAssetManager.list(status ?? undefined).then((roles) => json({ roles }));
	},

	"GET /api/roles/:id": (_req, ctx) => {
		if (!ctx.services.roleAssetManager) return json({ error: "Role asset manager not available" }, 503);
		const id = ctx.params.id;
		if (!id) return json({ error: "Missing role ID" }, 400);
		return ctx.services.roleAssetManager.get(id).then((role) => {
			if (!role) return json({ error: "Role not found" }, 404);
			return json(role);
		});
	},

	"POST /api/roles": async (req, ctx) => {
		if (!ctx.services.roleAssetManager) return json({ error: "Role asset manager not available" }, 503);
		try {
			const body = (await req.json()) as import("../role-asset").RoleCreateInput;
			if (!body.id || !body.name || !body.prompts) return json({ error: "Missing required fields: id, name, prompts" }, 400);
			const role = await ctx.services.roleAssetManager.create(body);
			return json(role, 201);
		} catch (err) {
			return json({ error: String(err) }, 409);
		}
	},

	"PUT /api/roles/:id": async (req, ctx) => {
		if (!ctx.services.roleAssetManager) return json({ error: "Role asset manager not available" }, 503);
		const id = ctx.params.id;
		if (!id) return json({ error: "Missing role ID" }, 400);
		try {
			const body = (await req.json()) as import("../role-asset").RoleUpdateInput;
			const role = await ctx.services.roleAssetManager.update(id, body);
			return json(role);
		} catch (err) {
			const msg = String(err);
			if (msg.includes("not found")) return json({ error: msg }, 404);
			return json({ error: msg }, 500);
		}
	},

	"POST /api/roles/:id/approve": async (_req, ctx) => {
		if (!ctx.services.roleAssetManager) return json({ error: "Role asset manager not available" }, 503);
		const id = ctx.params.id;
		if (!id) return json({ error: "Missing role ID" }, 400);
		try {
			const role = await ctx.services.roleAssetManager.approve(id);
			return json(role);
		} catch (err) {
			const msg = String(err);
			if (msg.includes("not found")) return json({ error: msg }, 404);
			return json({ error: msg }, 400);
		}
	},

	"POST /api/roles/:id/deprecate": async (_req, ctx) => {
		if (!ctx.services.roleAssetManager) return json({ error: "Role asset manager not available" }, 503);
		const id = ctx.params.id;
		if (!id) return json({ error: "Missing role ID" }, 400);
		try {
			const role = await ctx.services.roleAssetManager.deprecate(id);
			return json(role);
		} catch (err) {
			const msg = String(err);
			if (msg.includes("not found")) return json({ error: msg }, 404);
			return json({ error: msg }, 500);
		}
	},

	"DELETE /api/roles/:id": async (_req, ctx) => {
		if (!ctx.services.roleAssetManager) return json({ error: "Role asset manager not available" }, 503);
		const id = ctx.params.id;
		if (!id) return json({ error: "Missing role ID" }, 400);
		try {
			const deleted = await ctx.services.roleAssetManager.delete(id);
			if (!deleted) return json({ error: "Role not found" }, 404);
			return json({ success: true });
		} catch (err) { return json({ error: String(err) }, 500); }
	},

	// -- Models ----------------------------------------------------------
	"GET /api/models": (_req, ctx) => {
		if (!ctx.services.modelRegistry) {
			return json({
				models: [{ id: "deepseek-chat", name: "DeepSeek Chat", provider: "deepseek", tier: "worker" }],
				warning: "ModelRegistry not available; returning fallback list",
			});
		}
		const available = ctx.services.modelRegistry.getAvailable();
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


	// -- Sessions (create / list) ---------------------------------------
	"POST /api/sessions": async (req, ctx) => {
		try {
			const body = (await req.json()) as { name: string };
			if (!body.name || typeof body.name !== "string") {
				return json({ error: "name is required" }, 400);
			}
			const registry = ctx.registry;
			const existing = registry.getSession(body.name);
			if (existing) return json({ name: body.name, exists: true });
			const session = await registry.createSession(body.name);
			return json({ name: session.name, exists: false });
		} catch (err) {
			return json({ error: String(err) }, 500);
		}
	},
	"DELETE /api/sessions": async (req, ctx) => {
		try {
			const body = (await req.json()) as { name: string };
			if (!body.name || typeof body.name !== "string") {
				return json({ error: "name is required" }, 400);
			}
			await ctx.registry.destroySession(body.name);
			return json({ success: true, name: body.name });
		} catch (err) {
			return json({ error: String(err) }, 500);
		}
	},

		// -- Session fork (global) ----------------------------------------------
		"POST /api/sessions/fork": async (req, ctx) => {
			try {
				const body = (await req.json()) as { parent: string; name: string };
				if (!body.parent || !body.name) return json({ error: "parent and name are required" }, 400);
				const session = await ctx.registry.forkSession(body.parent, body.name);
				return json({ name: session.name, parent: body.parent }, 201);
			} catch (err) {
				return json({ error: String(err) }, 500);
			}
		},
	// -- Runs (list all sessions) ----------------------------------------
	"GET /api/runs": async (_req, ctx) => {
		try {
			const fs = await import("node:fs/promises");
			const entries = await fs.readdir(ctx.paths.workspaceDir);
			const swarms = entries.filter((e) => e.startsWith(".swarm_"));
			const runs = await Promise.all(swarms.map(async (dir) => {
				const name = dir.replace(".swarm_", "");
				const swarmDir = path.join(ctx.paths.workspaceDir, dir);
				let lastActivity: string | null = null;
				let messageCount = 0;
				let status: "idle" | "running" | "completed" | "failed" = "idle";
				// Read latest state from session.jsonl
				const latestState = await SwarmSessionManager.readLatestState(swarmDir);
				if (latestState) {
					status = (latestState.status as typeof status) ?? "idle";
					const completedAt = (latestState as any).completedAt;
					const startedAt = (latestState as any).startedAt;
					if (completedAt) lastActivity = new Date(completedAt).toISOString();
					else if (startedAt) lastActivity = new Date(startedAt).toISOString();
				}
				// Count activity entries from session.jsonl
				messageCount = await SwarmSessionManager.countActivityEntries(swarmDir);
				return { name, dir, lastActivity, messageCount, status };
			}));
			runs.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
			return json({ runs });
		} catch { return json({ runs: [] }); }
	},

	"GET /api/runs/:name/activity": async (_req, ctx) => {
		const name = ctx.params.name;
		if (!name) return json({ error: "Missing run name" }, 400);
		const lines = await readActivityLog(path.join(ctx.paths.workspaceDir, `.swarm_${name}`));
		const entries = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
		return json({ entries });
	},

	"GET /api/runs/:name": async (_req, ctx) => {
		const name = ctx.params.name;
		if (!name) return json({ error: "Missing run name" }, 400);
		const lines = await readActivityLog(path.join(ctx.paths.workspaceDir, `.swarm_${name}`));
		return json({ name, dir: `.swarm_${name}`, messageCount: lines.length });
	},

	// -- Experience store (workspace-shared) -----------------------------
	"GET /api/experience": async (req, ctx) => {
		if (!ctx.services.experienceStore) return json({ error: "Experience store not available" }, 503);
		const url = new URL(req.url);
		const query = url.searchParams.get("q") ?? "";
		const limit = parseInt(url.searchParams.get("limit") ?? "10", 10);
		if (!query) return json({ results: [] });
		return json({ results: ctx.services.experienceStore.search(query, limit) });
	},

	"GET /api/experience/stats": async (_req, ctx) => {
		if (!ctx.services.experienceStore) return json({ error: "Experience store not available" }, 503);
		return json(ctx.services.experienceStore.getAggregateStats());
	},

	"GET /api/experience/recent": async (req, ctx) => {
		if (!ctx.services.experienceStore) return json({ error: "Experience store not available" }, 503);
		const url = new URL(req.url);
		const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
		return json({ lessons: ctx.services.experienceStore.getRecentLessons(limit) });
	},
};
