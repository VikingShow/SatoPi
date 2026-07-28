/**
 * createSwarmSession — factory that wires up a full swarm session.
 *
 * This replaces the former SessionRegistry.createSession(). The logic lives
 * in swarm/ so all the heavy imports stay where they belong.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { OffloadManager } from "../../offload/manager";
import { OffloadSource } from "../context-manager/sources/offload-source";
import { registerBuiltinHooks } from "../hook-system/register-builtins";
import type { ActivityBroadcaster } from "../infra/activity-logger";
import type { SessionFactory, SessionServices, SharedServices } from "./session-types";
import { SwarmSessionManager } from "./swarm-session-manager";

export async function createSwarmSession(
	shared: SharedServices,
	factory: SessionFactory,
	name: string,
	options?: {
		broadcaster?: ActivityBroadcaster | null;
		maxConcurrent?: number;
		runtime?: SessionServices["runtime"];
	},
): Promise<SessionServices> {
	const swarmDir = path.join(shared.workspace, ".stp", "sessions", `swarm-${name}`);
	await fs.mkdir(swarmDir, { recursive: true });

	const services = await factory(shared, name, swarmDir);
	const abortController = new AbortController();

	// Create SwarmSessionManager for unified OH-MY-PI persistence.
	let sessionManager: SwarmSessionManager | undefined;
	try {
		sessionManager = await SwarmSessionManager.openOrCreate(swarmDir);
		logger.info("[createSwarmSession] SwarmSessionManager created", { name, swarmDir });
	} catch (err) {
		logger.warn("[createSwarmSession] SwarmSessionManager unavailable — falling back to legacy persistence", {
			error: String(err),
		});
	}

	// Wire the SSE broadcaster to the new session's ActivityLogger.
	if (options?.broadcaster) {
		services.activityLogger.setBroadcaster(options.broadcaster);
	}

	const session: SessionServices = {
		...services,
		abortController,
		sessionManager,
	};

	// Inject SwarmSessionManager into legacy persistence layers (dual-write).
	if (sessionManager) {
		services.stateTracker.setSessionManager(sessionManager);
		services.activityLogger.setSessionManager(sessionManager);
		services.scriptManager.setSessionManager?.(sessionManager);

		// Seed the in-memory StateTracker from the persisted snapshot.
		const snapshot = await SwarmSessionManager.readLatestState(swarmDir);
		if (snapshot) {
			services.stateTracker.updatePipeline(snapshot);
			logger.info("[createSwarmSession] seeded StateTracker from persisted snapshot", {
				name,
				status: snapshot.status,
				phase: snapshot.phase,
			});
		}

		// v3: Wire real OffloadManager and register builtin hooks.
		if (services.hookPipeline) {
			const offloadManager = new OffloadManager(shared.workspace, name, name, sessionManager.storage);
			session.offloadManager = offloadManager;

			// Register OffloadSource on the context pipeline.
			if (options?.runtime?.contextPipeline) {
				options.runtime.contextPipeline.register(new OffloadSource(offloadManager));
			}

			registerBuiltinHooks(services.hookPipeline, {
				offloadManager,
				profileRegistry: shared.profileRegistry,
			});
			logger.info("[createSwarmSession] Builtin hooks registered with OffloadManager", { name });
		}
	}

	return session;
}

/**
 * Destroy a swarm session — abort its controller, flush/close the session
 * manager, and remove the on-disk directory.
 */
export async function destroySwarmSession(session: SessionServices, workspace: string): Promise<void> {
	session.abortController.abort();
	if (session.sessionManager) {
		try {
			await session.sessionManager.flush();
		} catch {
			/* best-effort */
		}
		try {
			await session.sessionManager.close();
		} catch {
			/* best-effort */
		}
	}
	const swarmDir = path.join(workspace, ".stp", "sessions", `swarm-${session.name}`);
	try {
		await fs.rm(swarmDir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

/**
 * Fork an existing session — creates a new session with the parent's history.
 */
export async function forkSwarmSession(
	parent: SessionServices,
	newName: string,
	shared: SharedServices,
	factory: SessionFactory,
	runtime?: SessionServices["runtime"],
): Promise<SessionServices> {
	const session = await createSwarmSession(shared, factory, newName, { runtime });
	if (parent.sessionManager && session.sessionManager) {
		try {
			const forkResult = await parent.sessionManager.fork();
			if (forkResult) {
				await session.sessionManager.close();
				session.sessionManager = await SwarmSessionManager.open(forkResult.newSessionFile, session.swarmDir);

				await parent.sessionManager.close();
				parent.sessionManager = await SwarmSessionManager.open(forkResult.oldSessionFile, parent.swarmDir);

				const snapshot = await SwarmSessionManager.readLatestState(session.swarmDir);
				if (snapshot) {
					session.stateTracker.updatePipeline(snapshot);
				}
			}
			logger.info("[forkSwarmSession] Forked session", { parent: parent.name, child: newName });
		} catch (err) {
			logger.warn("[forkSwarmSession] Session fork failed", { error: String(err) });
		}
	}
	return session;
}
