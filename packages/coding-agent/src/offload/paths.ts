/**
 * offload-paths — canonical path utilities for context offload storage.
 *
 * All offload-related paths live under {workspace}/.stp/ (resolved via
 * getProjectAgentDir so PI_CONFIG_DIR overrides are honored):
 *
 *   {workspace}/.stp/offload/       — JSONL offload entries per agent
 *   {workspace}/.stp/offload/{agentName}/mmds/   — Mermaid context-graph diagrams
 *   {workspace}/.stp/profiles/      — Swarm profiles
 *
 * This module is the SINGLE source of truth for offload directory layout.
 * Every offload consumer MUST use these functions.
 */

import { getProjectAgentDir } from "@oh-my-pi/pi-utils";

import * as path from "node:path";

// ============================================================================
// Directory helpers
// ============================================================================

/**
 * Offload directory root.
 *
 * Path: {workspace}/.stp/offload
 */
export function getOffloadDir(workspace: string): string {
	return path.join(getProjectAgentDir(workspace), "offload");
}

/**
 * Agent-specific data directory.
 *
 * Path: {workspace}/.stp/offload/{agentName}
 */
export function getAgentDataDir(workspace: string, agentName: string): string {
	return path.join(getOffloadDir(workspace), agentName);
}

/**
 * Mermaid diagram storage directory.
 *
 * Path: {workspace}/.stp/offload/{agentName}/mmds
 */
export function getMmdsDir(workspace: string, agentName: string): string {
	return path.join(getAgentDataDir(workspace, agentName), "mmds");
}

/**
 * Swarm profiles directory.
 *
 * Path: {workspace}/.stp/profiles
 */
export function getProfilesDir(workspace: string): string {
	return path.join(getProjectAgentDir(workspace), "profiles");
}

// ============================================================================
// File path helpers
// ============================================================================

/**
 * Offload JSONL file for a specific agent.
 *
 * Path: {workspace}/.stp/offload/{agentName}/offload-{sessionId}.jsonl
 */
export function getOffloadPath(workspace: string, agentName: string, sessionId: string): string {
	return path.join(getAgentDataDir(workspace, agentName), `offload-${sessionId}.jsonl`);
}

/**
 * Active Mermaid context-graph file.
 *
 * Path: {workspace}/.stp/offload/{agentName}/mmds/context-graph.mmd
 */
export function getMmdPath(workspace: string, agentName: string): string {
	return path.join(getMmdsDir(workspace, agentName), "context-graph.mmd");
}

/**
 * Archived Mermaid context-graph file for a specific iteration.
 *
 * Path: {workspace}/.stp/offload/{agentName}/mmds/iter-{iter}-context-graph.mmd
 */
export function getArchivedMmdPath(workspace: string, agentName: string, iteration: number): string {
	return path.join(getMmdsDir(workspace, agentName), `iter-${iteration}-context-graph.mmd`);
}

/**
 * Agent state file.
 *
 * Path: {workspace}/.stp/offload/{agentName}/state.json
 */
export function getStatePath(workspace: string, agentName: string): string {
	return path.join(getAgentDataDir(workspace, agentName), "state.json");
}
