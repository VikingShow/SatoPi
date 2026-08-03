/**
 * Swarm service interfaces — dependency inversion for swarm orchestration.
 *
 * These interfaces decouple the swarm engine from concrete implementations.
 * Includes agent lifecycle (SwarmAgentRunner), communication (SwarmMessageBus),
 * and phase orchestration (RunManager, SteeringSink).
 */

import type { SwarmSessionManager } from "../session/swarm-session-manager";

// ============================================================================
// Phase orchestration — extracted from monitor/api-routes.ts
// ============================================================================

// ============================================================================

/** Controls the swarm loop lifecycle. Implemented by GraphRunnerAsRunManager. */
export interface RunManager {
	setSessionManager?(sm: SwarmSessionManager): void;
	start(agentCount?: number): Promise<{ success: boolean; error?: string }>;
	stop(): Promise<{ success: boolean; error?: string }>;
	pause(): Promise<{ success: boolean; error?: string }>;
	resume(): Promise<{ success: boolean; error?: string }>;
	updatePlanAndContinue(content: string): Promise<{ success: boolean; error?: string }>;
	readonly isRunning: boolean;
	getLastCurtainResult?: () => Record<string, unknown> | null;
}

/** Accepts steering messages from the human during a running loop. */
export interface SteeringSink {
	steer(text: string): void;
}
