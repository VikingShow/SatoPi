/**
 * SessionRegistry — manages all swarm sessions.
 *
 * Each session owns its own StateTracker, ActivityLogger, RunManager,
 * ScriptManager, SteeringSink, and AbortController.  Sessions share
 * workspace-scoped services (ExperienceStore, ModelRegistry, RoleAssetManager)
 * through a SharedServices bag.
 *
 * SessionSpec: the per-session factory is responsible for creating the
 * full per-session service graph.  This keeps SessionRegistry agnostic
 * about how each component is wired up.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { StateTracker } from "../core/state";
import type { ActivityLogger, ActivityBroadcaster } from "../hooks/activity-logger";
import type { RunManager, SteeringSink } from "../monitor/api-routes";
import type { ScriptManager } from "../monitor/api-routes";
import type { ExperienceStore } from "../curtain/experience";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { RoleAssetManager } from "../agent/role-asset";
import type { ProfileRegistry } from "../agent/agent-profile";
// NOTE: SwarmSessionManager is used at RUNTIME (openOrCreate), not just as a
// type — the `import type` above is kept for documentation but the value import
// is what makes persistence actually work.
import { SwarmSessionManager } from "./swarm-session-manager";
import { logger } from "@oh-my-pi/pi-utils";

// ============================================================================
// Types
// ============================================================================

/** Workspace-scoped services — shared across all sessions. */
export interface SharedServices {
	workspace: string;
	yamlPath: string;
	modelRegistry: ModelRegistry;
	settings: Settings;
	experienceStore: ExperienceStore;
	roleAssetManager: RoleAssetManager;
	/** P7: AgentProfile registry — cross-run persistent agent identity. */
	profileRegistry: ProfileRegistry;
}

/** The complete per-session service graph. */
export interface SessionServices {
	name: string;
	swarmDir: string;
	stateTracker: StateTracker;
	activityLogger: ActivityLogger;
	runManager: RunManager;
	scriptManager: ScriptManager;
	steeringSink: SteeringSink;
	abortController: AbortController;
	/** OH-MY-PI-based session persistence (replaces pipeline.json, activity.jsonl, conversation.json). */
	sessionManager?: SwarmSessionManager;
}

/** High-level session status for the run listing. */
export type SessionStatus =
	| "idle"
	| "script"
	| "stage"
	| "paused"
	| "blocked"
	| "completed"
	| "failed";

/** Factory function signature — builds all per-session objects for a given swarmDir. */
export type SessionFactory = (
	shared: SharedServices,
	name: string,
	swarmDir: string,
) => Promise<Omit<SessionServices, "abortController">>;

// ============================================================================
// SessionRegistry
// ============================================================================

export class SessionRegistry {
	readonly #shared: SharedServices;
	readonly #sessions = new Map<string, SessionServices>();
	#maxConcurrent: number;
	#factory: SessionFactory;
	/** Optional SSE broadcaster auto-injected into every new session. */
	#broadcaster: ActivityBroadcaster | null = null;

	constructor(
		shared: SharedServices,
		factory: SessionFactory,
		maxConcurrent = Infinity,
	) {
		this.#shared = shared;
		this.#factory = factory;
		this.#maxConcurrent = maxConcurrent;
	}

	/**
	 * Register an SSE broadcaster.  Once set, every session created via
	 * createSession() (including those from the REST API) automatically
	 * gets its ActivityLogger wired to this broadcaster.
	 */
	setBroadcaster(broadcaster: ActivityBroadcaster): void {
		this.#broadcaster = broadcaster;
	}

	get shared(): SharedServices {
		return this.#shared;
	}

	get workspace(): string {
		return this.#shared.workspace;
	}

	// ── Query ─────────────────────────────────────────────────────────────

	getSession(name: string): SessionServices | undefined {
		return this.#sessions.get(name);
	}

	get activeSessions(): SessionServices[] {
		return [...this.#sessions.values()];
	}

	get activeCount(): number {
		return this.#sessions.size;
	}

	canStart(): boolean {
		return this.#sessions.size < this.#maxConcurrent;
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────

	async createSession(name: string): Promise<SessionServices> {
		if (this.#sessions.has(name)) {
			throw new Error(`Session "${name}" already exists`);
		}
		if (!this.canStart()) {
			throw new Error(
				`Max ${this.#maxConcurrent} concurrent sessions reached`,
			);
		}

		const swarmDir = path.join(this.#shared.workspace, `.swarm_${name}`);
		await fs.mkdir(swarmDir, { recursive: true });

		const services = await this.#factory(this.#shared, name, swarmDir);
		const abortController = new AbortController();

		// Create SwarmSessionManager for unified OH-MY-PI persistence.
		// This replaces pipeline.json, activity.jsonl, and conversation.json.
		let sessionManager: SwarmSessionManager | undefined;
		try {
			sessionManager = await SwarmSessionManager.openOrCreate(swarmDir);
			logger.info("[SessionRegistry] SwarmSessionManager created", { name, swarmDir });
		} catch (err) {
			logger.warn("[SessionRegistry] SwarmSessionManager unavailable — falling back to legacy persistence", { error: String(err) });
		}

		// Wire the SSE broadcaster to the new session's ActivityLogger.
		// This covers both startup-created sessions and sessions created
		// later via the REST API (POST /api/sessions).
		if (this.#broadcaster) {
			services.activityLogger.setBroadcaster(this.#broadcaster);
		}

		const session: SessionServices = {
			...services,
			abortController,
			sessionManager,
		};

		// Inject SwarmSessionManager into legacy persistence layers (dual-write).
		// Each service keeps its existing file writes AND additionally writes to
		// session.jsonl through the SessionManager.
		if (sessionManager) {
			services.stateTracker.setSessionManager(sessionManager);
			services.activityLogger.setSessionManager(sessionManager);
			services.scriptManager.setSessionManager?.(sessionManager);

			// Seed the in-memory StateTracker from the persisted snapshot when
			// the session.jsonl already existed (e.g. backend restart recovering
			// a historical session). Without this, GET /api/runs reports the
			// persisted status (completed/failed) from readLatestState but the
			// in-memory StateTracker is still the empty "idle" default — the
			// session list and the live state disagree, producing a ghost session.
			const snapshot = await SwarmSessionManager.readLatestState(swarmDir);
			if (snapshot) {
				services.stateTracker.updatePipeline(snapshot);
				logger.info("[SessionRegistry] seeded StateTracker from persisted snapshot", {
					name, status: snapshot.status, phase: snapshot.phase,
				});
			}
		}

		this.#sessions.set(name, session);
		return session;
	}

	async destroySession(name: string): Promise<void> {
		const session = this.#sessions.get(name);
		if (!session) return;
		session.abortController.abort();
		// Flush and close SwarmSessionManager before cleanup
		if (session.sessionManager) {
			try { await session.sessionManager.flush(); } catch { /* best-effort */ }
			try { await session.sessionManager.close(); } catch { /* best-effort */ }
		}
		// Remove from in-memory registry
		this.#sessions.delete(name);
		// Remove the .swarm_{name} directory from disk so GET /api/runs
		// (which scans the workspace filesystem) does not resurrect it.
		const swarmDir = path.join(this.#shared.workspace, `.swarm_${name}`);
		try { await fs.rm(swarmDir, { recursive: true, force: true }); } catch { /* best-effort */ }
	}

	async destroyAll(): Promise<void> {
		for (const name of [...this.#sessions.keys()]) {
			await this.destroySession(name);
		}
	}

	/**
	 * Fork an existing session: creates a new session with the parent's
	 * session.jsonl history copied over, linked via parentSession header.
	 */
	async forkSession(parentName: string, newName: string): Promise<SessionServices> {
		const parent = this.#sessions.get(parentName);
		if (!parent) throw new Error(`Parent session "${parentName}" not found`);

		const session = await this.createSession(newName);
		if (parent.sessionManager && session.sessionManager) {
			try {
				await parent.sessionManager.fork();
				logger.info("[SessionRegistry] Forked session", { parent: parentName, child: newName });
			} catch (err) {
				logger.warn("[SessionRegistry] Session fork failed", { error: String(err) });
			}
		}
		return session;
	}

	// ── Path helpers ──────────────────────────────────────────────────────

	getPlanPath(name: string): string {
		const session = this.#sessions.get(name);
		if (!session) throw new Error(`Session "${name}" not found`);
		return path.join(session.swarmDir, ".omp", "plan.md");
	}

	getPlanArchiveDir(): string {
		return path.join(this.#shared.workspace, ".omp", "plans");
	}
}
