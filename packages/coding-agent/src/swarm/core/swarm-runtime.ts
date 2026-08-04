/**
 * SwarmRuntime — minimal spawn interface for orchestrator consumers.
 *
 * Replaces the (now-removed) AgentRuntime concrete class in public interfaces
 * (ISwarmOrchestrator, PhaseContext) so callers depend only on spawn + ircBus.
 *
 * AgentRuntime was fully deleted in the Phase 5 migration — SwarmRuntime is the
 * interface facade over the spawnAgent() pure function (see graph/agent-helpers.ts).
 */

import type { AgentSpec } from "../../graph/agent-spec";
import type { IrcBus } from "../../irc/bus";
import type { AgentSession } from "../../session/agent/agent-session";

export interface SwarmRuntime {
	/** Spawn agents from declarative specs. */
	spawn(specs: AgentSpec[]): Promise<AgentSession[]>;
	/** Context pipeline for per-agent context assembly. */
	readonly contextPipeline: import("../../context/context-pipeline").ContextPipeline;
	/** Communication bus for human steering and agent messaging. */
	readonly ircBus: IrcBus;
	/** Queue a human steering message for a specific agent. */
	sendHumanMessage(agentId: string, text: string): Promise<void>;
}
