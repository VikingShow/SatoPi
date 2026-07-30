/**
 * Session tree directory layout helpers.
 *
 * Layout:
 *   {parent-session-dir}/
 *     {agent-id}.jsonl              ← subagent session (task spawn)
 *     swarm-{name}/
 *       .session/swarm.jsonl        ← SwarmSessionManager metadata
 *       agents/{agent-id}.jsonl     ← swarm agent sessions
 *       crews/{crew-id}.jsonl       ← crew transcripts
 *       roundtables/{id}.jsonl      ← roundtable transcripts
 */

import * as path from "node:path";

/**
 * Derive the parent session directory from a session file path.
 * Strips the .jsonl extension to get the artifact container directory.
 */
export function getSessionDir(sessionFile: string): string {
	return sessionFile.replace(/\.jsonl$/, "");
}

/**
 * Get the path for a subagent's session file under the parent session directory.
 */
export function getAgentSessionPath(parentSessionFile: string, agentId: string): string {
	return path.join(getSessionDir(parentSessionFile), `${agentId}.jsonl`);
}

/**
 * Get the swarm directory under the parent session directory.
 */
export function getSwarmDir(parentSessionFile: string, swarmName: string): string {
	return path.join(getSessionDir(parentSessionFile), `swarm-${swarmName}`);
}

/**
 * Get the agents subdirectory for a swarm.
 */
export function getSwarmAgentsDir(parentSessionFile: string, swarmName: string): string {
	return path.join(getSwarmDir(parentSessionFile, swarmName), "agents");
}

/**
 * Get the session file path for a swarm agent.
 */
export function getSwarmAgentSessionPath(parentSessionFile: string, swarmName: string, agentId: string): string {
	return path.join(getSwarmAgentsDir(parentSessionFile, swarmName), `${agentId}.jsonl`);
}

/**
 * Get the swarm metadata session directory.
 */
export function getSwarmSessionDir(parentSessionFile: string, swarmName: string): string {
	return path.join(getSwarmDir(parentSessionFile, swarmName), ".session");
}

/**
 * Get the crews directory for a swarm.
 */
export function getCrewsDir(parentSessionFile: string, swarmName: string): string {
	return path.join(getSwarmDir(parentSessionFile, swarmName), "crews");
}

/**
 * Get the transcript path for a crew.
 */
export function getCrewTranscriptPath(parentSessionFile: string, swarmName: string, crewId: string): string {
	return path.join(getCrewsDir(parentSessionFile, swarmName), `${crewId}.jsonl`);
}

/**
 * Get the roundtables directory for a swarm.
 */
export function getRoundtablesDir(parentSessionFile: string, swarmName: string): string {
	return path.join(getSwarmDir(parentSessionFile, swarmName), "roundtables");
}

/**
 * Get the transcript path for a roundtable session.
 */
export function getRoundtableTranscriptPath(
	parentSessionFile: string,
	swarmName: string,
	roundtableId: string,
): string {
	return path.join(getRoundtablesDir(parentSessionFile, swarmName), `${roundtableId}.jsonl`);
}
