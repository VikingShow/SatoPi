/**
 * SessionRegistry — manages all swarm sessions.
 *
 * Each session owns its own StateTracker, ActivityLogger, RunManager,
 * BeforeLoopManager, SteeringSink, and AbortController.  Sessions share
 * workspace-scoped services (ExperienceStore, ModelRegistry, RoleAssetManager)
 * through a SharedServices bag.
 *
 * SessionSpec: the per-session factory is responsible for creating the
 * full per-session service graph.  This keeps SessionRegistry agnostic
 * about how each component is wired up.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { StateTracker } from "./state";
import type { ActivityLogger } from "./activity-logger";
import type { RunManager, SteeringSink } from "./monitor/api-routes";
import type { BeforeLoopManager } from "./before-loop-manager";
import type { ExperienceStore } from "./after-loop/experience";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { RoleAssetManager } from "./role-asset";
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
}

/** The complete per-session service graph. */
export interface SessionServices {
	name: string;
	swarmDir: string;
	stateTracker: StateTracker;
	activityLogger: ActivityLogger;
	runManager: RunManager;
	beforeLoopManager: BeforeLoopManager;
	steeringSink: SteeringSink;
	abortController: AbortController;
	/** OH-MY-PI-based session persistence (replaces pipeline.json, activity.jsonl, conversation.json). */
	sessionManager?: SwarmSessionManager;
}

export type SessionStatus =
	| "idle"
	| "before-loop"
	| "running"
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

	constructor(
		shared: SharedServices,
		factory: SessionFactory,
		maxConcurrent = Infinity,
	) {
		this.#shared = shared;
		this.#factory = factory;
		this.#maxConcurrent = maxConcurrent;
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
			services.beforeLoopManager.setSessionManager(sessionManager);
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
		this.#sessions.delete(name);
	}

	async destroyAll(): Promise<void> {
		for (const name of [...this.#sessions.keys()]) {
			await this.destroySession(name);
		}
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
