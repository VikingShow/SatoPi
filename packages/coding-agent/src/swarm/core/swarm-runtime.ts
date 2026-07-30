/**
 * SwarmRuntime — minimal spawn interface for orchestrator consumers.
 *
 * Replaces the full AgentRuntime type in public interfaces (ISwarmOrchestrator,
 * PhaseContext) so callers depend only on spawn + ircBus, not the concrete class.
 *
 * AgentRuntime satisfies this interface via duck typing during the transition;
 * once all callers migrate to spawnAgent() directly, AgentRuntime is deleted.
 */

import type { AgentSession } from "../session/agent-session";
import type { IrcBus } from "../irc/bus";
import type { AgentSpec } from "../graph/agent-spec";

export interface SwarmRuntime {
	/** Spawn agents from declarative specs. */
	spawn(specs: AgentSpec[]): Promise<AgentSession[]>;
	/** Context pipeline for per-agent context assembly. */
	readonly contextPipeline: import("../../swarm/context-manager/context-pipeline").ContextPipeline;
	/** Communication bus for human steering and agent messaging. */
	readonly ircBus: IrcBus;
}
