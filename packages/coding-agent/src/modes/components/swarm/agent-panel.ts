/**
 * Agent Panel — renders agent status as ANSI-coloured panel lines.
 *
 * Primary data source: AgentRegistry (AgentRef list).
 * Optional enrichment: SwarmState for swarm-specific metrics (iteration, wave, praiseCount).
 *
 * Shows each agent with role, current task, duration, status glyph, and
 * profile credit score for persistent agents.
 * Includes reviewer tag line when a reviewer agent is elected.
 */

import { type AgentRef, AgentRegistry } from "../../../registry/agent-registry";
import type { SwarmState } from "../../../swarm/core/state";
import { makeFooter, makeHeader, padLine } from "./panel-utils";
import { sato } from "./theme";

const STATUS_GLYPH: Record<string, string> = {
	completed: "✓",
	running: "◌",
	waiting: "○",
	failed: "✗",
	pending: "·",
	idle: "✓",
	parked: "○",
	aborted: "⊘",
};

const STATUS_COLOR: Record<string, (text: string) => string> = {
	completed: sato.success,
	running: sato.info,
	waiting: sato.warning,
	failed: sato.danger,
	pending: sato.muted,
	idle: sato.success,
	parked: sato.muted,
	aborted: sato.danger,
};

const STATUS_LABEL: Record<string, string> = {
	completed: "done",
	running: "running",
	waiting: "waiting for tasks",
	failed: "failed",
	pending: "pending",
	idle: "done",
	parked: "parked",
	aborted: "aborted",
};
// ============================================================================
// Public API
// ============================================================================

/**
 * Render the agent status panel.
 *
 * Primary source: `agents` from `AgentRegistry.global().list()`.
 * Optional swarm enrichment: `swarmState` overlays iteration, wave,
 * praiseCount, and per-agent swarm-specific metrics when available.
 *
 * Returns an array of chalk-coloured strings, one per display line.
 * Every visible line is guaranteed to be at most `maxWidth` columns wide.
 *
 * Gracefully handles:
 *  - Empty agents (shows "No agents" placeholder)
 *  - Null/undefined swarmState (renders from registry only)
 *  - Missing optional fields
 */
export function renderAgentPanel(
	agents: AgentRef[],
	swarmState: SwarmState | null | undefined,
	maxWidth: number,
): string[] {
	if (agents.length === 0 && !swarmState?.agents) {
		return emptyPanel(maxWidth, "No agents");
	}

	const innerWidth = maxWidth - 4; // "│ " + content + " │"
	if (innerWidth < 10) return [];

	const lines: string[] = [];

	// Header
	lines.push(makeHeader("Agents", maxWidth));

	// Merge: AgentRef list is primary; swarm state enriches.
	// Use AgentRef list when available; fall back to swarmState.agents.
	const agentList = agents.length > 0 ? agents : buildAgentRefsFromSwarm(swarmState);

	if (agentList.length === 0) {
		lines.push(padLine(` ${sato.dim("No agents")}`, maxWidth));
	} else {
		// Sort: persistent/reviewer first, then by displayName
		const sorted = [...agentList].sort((a, b) => {
			const aRole = a.role ?? swarmState?.agents[a.id]?.role;
			const bRole = b.role ?? swarmState?.agents[b.id]?.role;
			if (aRole === "reviewer" && bRole !== "reviewer") return -1;
			if (bRole === "reviewer" && aRole !== "reviewer") return 1;
			return a.displayName.localeCompare(b.displayName);
		});

		// Agent lines (up to 20, then summary)
		const maxAgentLines = 20;
		const shown = sorted.slice(0, maxAgentLines);
		for (const ref of shown) {
			const swarmAgent = swarmState?.agents[ref.id];
			lines.push(formatAgentLine(ref, swarmAgent, innerWidth, maxWidth));
		}
		if (sorted.length > maxAgentLines) {
			lines.push(padLine(` ${sato.dim(`... and ${sorted.length - maxAgentLines} more agents`)}`, maxWidth));
		}
	}

	// Reviewer footer (from swarm state or ref role)
	const reviewer = agentList.find(ref => {
		const role = ref.role ?? swarmState?.agents[ref.id]?.role;
		return role === "reviewer";
	});
	if (reviewer) {
		const verdict = swarmState?.reviewVerdict;
		let footer = ` 👑 reviewer: ${reviewer.displayName}`;
		if (verdict) {
			const footerLen = footer.replace(/\x1b\[[0-9;]*m/g, "").length;
			const verdictMax = Math.max(5, innerWidth - (footerLen + 12));
			const display = verdict.length > verdictMax ? `${verdict.slice(0, verdictMax - 3)}...` : verdict;
			footer += `  ·  review: "${display}"`;
		}
		lines.push(padLine("", maxWidth));
		lines.push(padLine(footer, maxWidth));
	}

	// Footer
	lines.push(makeFooter(maxWidth));

	return lines;
}

// ============================================================================
// Internal
// ============================================================================

/**
 * Format a single agent line from an AgentRef, optionally enriched with
 * swarm-specific AgentState metrics.
 */
function formatAgentLine(
	ref: AgentRef,
	swarmAgent:
		| {
				status: string;
				iteration?: number;
				wave?: number;
				praiseCount?: number;
				error?: string;
				modelName?: string;
				startedAt?: number;
				completedAt?: number;
		  }
		| undefined,
	innerWidth: number,
	maxWidth: number,
): string {
	// Status: swarm agent status is ground truth when available; ref status is fallback
	const displayStatus = swarmAgent?.status ?? ref.status;
	const glyph = STATUS_GLYPH[displayStatus] ?? STATUS_GLYPH.idle;
	const colorFn = STATUS_COLOR[displayStatus] ?? STATUS_COLOR.idle;
	const glyphStr = colorFn(glyph);
	const name = ref.displayName;

	// Role badge: ref.role first, then swarm role
	const roleLabel = ref.role ?? swarmAgent?.role ?? swarmAgent?.modelName ?? "";
	const roleBadge = roleLabel ? sato.dim(`[${roleLabel}]`) : "";

	// Profile badge (persistent identity) — read credit from session profile
	let profileBadge = "";
	const profile = ref.session?.profile;
	if (profile) {
		profileBadge = sato.dim(`score:${profile.credit.score}`);
	}

	// Swarm metrics (shown when available from StateTracker and meaningful)
	let swarmMetrics = "";
	if (swarmAgent) {
		const parts: string[] = [];
		if ((swarmAgent.wave ?? 0) > 0) parts.push(`w${swarmAgent.wave}`);
		if ((swarmAgent.iteration ?? 0) > 0) parts.push(`i${swarmAgent.iteration}`);
		if ((swarmAgent.praiseCount ?? 0) > 0) parts.push(`👍${swarmAgent.praiseCount}`);
		if (parts.length > 0) swarmMetrics = sato.muted(parts.join(" "));
	}

	// Status text
	let statusText: string;
	if (displayStatus === "failed") {
		const err = swarmAgent?.error ?? "unknown error";
		statusText = `${STATUS_LABEL[displayStatus] ?? displayStatus}: ${err}`;
	} else if (displayStatus === "idle") {
		statusText = sato.success(STATUS_LABEL.idle);
	} else if (displayStatus === "running") {
		statusText = sato.info(STATUS_LABEL.running);
	} else {
		statusText = sato.dim(STATUS_LABEL[displayStatus] ?? displayStatus);
	}

	// Duration (from swarm agent timing or ref lastActivity)
	let durationStr = "";
	if (swarmAgent?.startedAt) {
		const end = swarmAgent.completedAt ?? Date.now();
		const ms = end - swarmAgent.startedAt;
		durationStr = sato.dim(`(${formatDuration(ms)})`);
	} else if (ref.status === "running" && ref.createdAt) {
		const ms = Date.now() - ref.createdAt;
		durationStr = sato.dim(`(${formatDuration(ms)})`);
	}

	// Assemble
	const segments: string[] = [glyphStr, name];
	if (roleBadge) segments.push(roleBadge);
	if (profileBadge) segments.push(profileBadge);
	if (swarmMetrics) segments.push(swarmMetrics);
	segments.push(statusText);
	if (durationStr) segments.push(durationStr);

	let line = ` ${segments.join(" ")}`;

	// If too long, truncate the status text
	if (line.replace(/\x1b\[[0-9;]*m/g, "").length > innerWidth) {
		const minimal = ` ${glyphStr} ${name}`;
		const minimalLen = minimal.replace(/\x1b\[[0-9;]*m/g, "").length;
		const suffix = durationStr ? ` ${durationStr}` : "";
		const suffixLen = suffix.replace(/\x1b\[[0-9;]*m/g, "").length;
		const statusBudget = innerWidth - minimalLen - suffixLen - 1;

		if (displayStatus === "failed" && statusBudget > 10) {
			const err = swarmAgent?.error ?? "unknown error";
			const errBudget = statusBudget - "failed: ".length;
			if (errBudget >= 3) {
				const truncated = err.length > errBudget ? `${err.slice(0, errBudget - 3)}...` : err;
				line = `${minimal} ${sato.danger(`failed: ${truncated}`)}${suffix}`;
			} else {
				line = `${minimal}${suffix}`;
			}
		} else if (statusBudget >= 3) {
			const label = STATUS_LABEL[displayStatus] ?? displayStatus;
			const truncated = label.length > statusBudget ? `${label.slice(0, statusBudget - 3)}...` : label;
			line = `${minimal} ${sato.dim(truncated)}${suffix}`;
		} else {
			line = `${minimal}${suffix}`;
		}
	}

	return padLine(line, maxWidth);
}

function formatDuration(ms: number): string {
	if (ms < 0) return "0s";
	if (ms < 1000) return "<1s";

	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 60) return `${totalSec}s`;

	const min = Math.floor(totalSec / 60);
	const sec = totalSec % 60;
	if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;

	const hr = Math.floor(min / 60);
	const remMin = min % 60;
	return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

/**
 * Fallback: build pseudo-AgentRef entries from SwarmState.agents when
 * AgentRegistry has no entries (legacy / test-only path).
 */
function buildAgentRefsFromSwarm(swarmState: SwarmState | null | undefined): AgentRef[] {
	if (!swarmState?.agents) return [];
	return Object.values(swarmState.agents).map(a => {
		const refStatus: "running" | "idle" | "parked" | "aborted" =
			a.status === "running"
				? "running"
				: a.status === "failed"
					? "aborted"
					: a.status === "completed" || a.status === "waiting" || a.status === "pending"
						? "idle"
						: "parked";
		return {
			id: a.name,
			displayName: a.name,
			kind: "sub" as const,
			status: refStatus,
			session: null,
			sessionFile: null,
			createdAt: a.startedAt ?? 0,
			lastActivity: a.completedAt ?? a.startedAt ?? 0,
			profileId: a.profileId,
			role: a.role,
		};
	});
}

function emptyPanel(maxWidth: number, message: string): string[] {
	const innerWidth = maxWidth - 4;
	if (innerWidth < 5) return [];
	return [makeHeader("Agents", maxWidth), padLine(` ${sato.dim(message)}`, maxWidth), makeFooter(maxWidth)];
}

/**
 * Legacy convenience: `renderAgentPanel()` that auto-reads from
 * `AgentRegistry.global()` so existing callers don't need to thread
 * the registry reference themselves.
 */
export function renderAgentPanelFromGlobalRegistry(
	swarmState: SwarmState | null | undefined,
	maxWidth: number,
): string[] {
	return renderAgentPanel(AgentRegistry.global().list(), swarmState, maxWidth);
}
