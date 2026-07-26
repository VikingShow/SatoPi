/**
 * Swarm service interfaces — dependency inversion for swarm orchestration.
 *
 * These interfaces decouple the swarm engine from concrete implementations.
 * Includes agent lifecycle (SwarmAgentRunner), communication (SwarmMessageBus),
 * and phase orchestration (RunManager, ScriptManager, SteeringSink).
 */

import type { ExecutorOptions, SingleResult } from "@oh-my-pi/pi-coding-agent";
import type { SwarmSessionManager } from "../session/swarm-session-manager";
import type { CurtainResult } from "../curtain/types";

// ============================================================================
// Agent execution & communication
// ============================================================================

/** Abstraction over subprocess agent execution. */
export interface SwarmAgentRunner {
	/** Spawn a local subprocess agent and return its result. */
	runSubprocess(options: ExecutorOptions): Promise<SingleResult>;
}

/** Abstraction over IRC-style inter-agent communication. */
export interface SwarmMessageBus {
	/** Broadcast a message to all agents on a channel. */
	broadcast(channel: string, sender: string, body: string): void;
	/** Send a directed message to a specific agent. */
	send(target: string, sender: string, body: string): void;
	/** Register a handler for incoming messages on a channel. */
	onMessage(channel: string, handler: (sender: string, body: string) => void): () => void;
}

/** Holds injectable services for the swarm pipeline. */
export interface SwarmServices {
	agentRunner?: SwarmAgentRunner;
	messageBus?: SwarmMessageBus;
}

// ============================================================================
// Phase orchestration — extracted from monitor/api-routes.ts
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
		phase: string; task: string; conversationLength: number;
		planReady: boolean; busy: boolean;
		selectedAgentId?: string; recommendedAgents?: number;
		estimatedAgentHours?: number;
	};
	getHistory(): Array<{ role: "user" | "assistant"; content: string }>;
	readonly isBusy: boolean;
}

/** Accepts steering messages from the human during a running loop. */
export interface SteeringSink {
	steer(text: string): void;
}
