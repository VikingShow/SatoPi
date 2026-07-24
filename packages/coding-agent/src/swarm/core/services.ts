/**
 * Swarm service interfaces — dependency inversion for swarm orchestration.
 *
 * P1-1: These interfaces decouple the swarm engine from concrete coding-agent
 * implementations (runSubprocess, IrcBus, ModelRegistry, etc.). The
 * coding-agent provides default implementations; swarm-extension injects them
 * via PipelineOptions.services.
 *
 * External consumers (tests, remote agents) can provide alternative
 * implementations without depending on the full coding-agent stack.
 */

import type { ExecutorOptions, SingleResult } from "@oh-my-pi/pi-coding-agent";

// ============================================================================
// Service interfaces
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
