/**
 * Swarm service interfaces — dependency inversion for swarm orchestration.
 *
 * These interfaces decouple the swarm engine from concrete implementations.
 * Includes agent lifecycle (SwarmAgentRunner), communication (SwarmMessageBus),
 * and phase orchestration (RunManager, ScriptManager, SteeringSink).
 */

import type { CurtainResult } from "../curtain/types";
import type { SwarmSessionManager } from "../session/swarm-session-manager";

// ============================================================================
// Phase orchestration — extracted from monitor/api-routes.ts
// ============================================================================

// ============================================================================

/** Controls the swarm loop lifecycle. Implemented by SwarmRunManager. */
export interface RunManager {
	setSessionManager?(sm: SwarmSessionManager): void;
	start(agentCount?: number): Promise<{ success: boolean; error?: string }>;
	stop(): Promise<{ success: boolean; error?: string }>;
	pause(): Promise<{ success: boolean; error?: string }>;
	resume(): Promise<{ success: boolean; error?: string }>;
	updatePlanAndContinue(content: string): Promise<{ success: boolean; error?: string }>;
	readonly isRunning: boolean;
	getLastCurtainResult?: () => CurtainResult | null;
	resolveBlocker?: (decision: "continue" | "skip" | "abort") => boolean;
}

/** Manages the Script (planning) phase. */
export interface ScriptManager {
	setSessionManager?(sm: SwarmSessionManager): void;
	start(task: string, agentId?: string): Promise<{ success: boolean; error?: string }>;
	sendMessage(text: string): Promise<{ success: boolean; error?: string }>;
	runDebate(): Promise<{ success: boolean; error?: string }>;
	confirm(agentCount?: number): Promise<{ success: boolean; error?: string }>;
	cancel(): Promise<{ success: boolean; error?: string }>;
	getState(): {
		phase: string;
		task: string;
		conversationLength: number;
		planReady: boolean;
		busy: boolean;
		selectedAgentId?: string;
		recommendedAgents?: number;
		estimatedAgentHours?: number;
	};
	getHistory(): Array<{ role: "user" | "assistant"; content: string }>;
	readonly isBusy: boolean;
}

/** Accepts steering messages from the human during a running loop. */
export interface SteeringSink {
	steer(text: string): void;
}
