/**
 * Swarm session types — shared service graph definitions.
 *
 * Extracted from the former session-registry.ts so they are available
 * without pulling in the full registry implementation.
 */

import type { ProfileRegistry } from "../../agent/agent-profile";
import type { RoleAssetManager } from "../../agent/role-asset";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { MarkEnvironment } from "../../coordination";
import type { IOffloadManager } from "../../offload/manager";
import type { ContextPipeline } from "../context-manager/context-pipeline";
import type { RunManager, SteeringSink } from "../core/services";
import type { StateTracker } from "../core/state";
import type { ExperienceStore } from "../curtain/experience";
import type { HookPipeline } from "../hook-system/hook-pipeline";
import type { ActivityLogger } from "../infra/activity-logger";
import type { SwarmHindsightClient } from "../infra/hindsight-adapter";
import type { MnemopiClient } from "../infra/mnemopi-adapter";
import type { SwarmSessionManager } from "./swarm-session-manager";

// ============================================================================
// Shared services — workspace-scoped, shared across all sessions
// ============================================================================

export interface SharedServices {
	workspace: string;
	yamlPath: string;
	modelRegistry: ModelRegistry;
	settings: Settings;
	experienceStore: ExperienceStore;
	roleAssetManager: RoleAssetManager;
	profileRegistry: ProfileRegistry;
	markEnvironment: MarkEnvironment;
	hindsightClient?: SwarmHindsightClient | null;
	mnemopiClient?: MnemopiClient | null;
}

// ============================================================================
// Per-session service graph
// ============================================================================

export interface SessionServices {
	name: string;
	swarmDir: string;
	stateTracker: StateTracker;
	activityLogger: ActivityLogger;
	runManager: RunManager;
	steeringSink: SteeringSink;
	abortController: AbortController;
	sessionManager?: SwarmSessionManager;
	hookPipeline?: HookPipeline;
	offloadManager?: IOffloadManager;
	runtime?: { contextPipeline: ContextPipeline };
}

// ============================================================================
// Session status
// ============================================================================

export type SessionStatus = "idle" | "script" | "stage" | "paused" | "blocked" | "completed" | "failed";

// ============================================================================
// Session factory
// ============================================================================

export type SessionFactory = (
	shared: SharedServices,
	name: string,
	swarmDir: string,
) => Promise<Omit<SessionServices, "abortController">>;
