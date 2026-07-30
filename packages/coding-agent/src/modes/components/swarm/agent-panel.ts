/**
 * Agent Panel — renders persistent agent status as ANSI-coloured lines inside
 * a system `framedBlock`.  Replaces the old `panel-utils.ts` box-drawing with
 * the shared `swarmPanel` wrapper and uses the global `theme` for all colours.
 */

import type { Component } from "@satopi/pi-tui";
import { type AgentRef, AgentRegistry } from "../../../registry/agent-registry";
import type { SwarmState } from "../../../swarm/core/state";
import { formatStatusIcon } from "../../../tools/render-utils";
import type { Theme } from "../../theme/theme";
import { swarmPanel } from "./swarm-panel-block";

// ============================================================================
// Status → theme icon + colour mapping
// ============================================================================

/** Maps agent registry / swarm statuses to `formatStatusIcon` statuses. */
const STATUS_ICON: Record<string, ToolUIStatus> = {
	completed: "done",
	failed: "error",
	aborted: "aborted",
	running: "running",
	idle: "done", // parked / idle — use the check glyph
	parked: "done",
	pending: "pending",
};

const STATUS_LABEL: Record<string, string> = {
	completed: "done",
	failed: "failed",
	aborted: "aborted",
	running: "running",
	idle: "idle",
	parked: "parked",
	pending: "pending",
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Render the agent status panel as a pi-tui `Component` (framed block).
 */
export function renderAgentPanel(
	agents: AgentRef[],
	swarmState: SwarmState | null | undefined,
	theme: Theme,
): Component {
	const title = "Agents";

	return swarmPanel(
		title,
		({ innerWidth, theme }) => {
			if (agents.length === 0 && !swarmState?.agents) {
				return [theme.fg("dim", "  No agents")];
			}

			const lines: string[] = [];

			const agentList = agents.length > 0 ? agents : buildAgentRefsFromSwarm(swarmState);

			if (agentList.length === 0) {
				lines.push(theme.fg("dim", "  No agents"));
			} else {
				const sorted = [...agentList].sort((a, b) => {
					const aRole = a.role ?? swarmState?.agents[a.id]?.role;
					const bRole = b.role ?? swarmState?.agents[b.id]?.role;
					if (aRole === "reviewer" && bRole !== "reviewer") return -1;
					if (bRole === "reviewer" && aRole !== "reviewer") return 1;
					return a.displayName.localeCompare(b.displayName);
				});

				const maxAgentLines = 20;
				const shown = sorted.slice(0, maxAgentLines);
				for (const ref of shown) {
					const swarmAgent = swarmState?.agents[ref.id];
					lines.push(formatAgentLine(ref, swarmAgent, innerWidth, theme));
				}
				if (sorted.length > maxAgentLines) {
					lines.push(theme.fg("dim", `  ... and ${sorted.length - maxAgentLines} more agents`));
				}
			}

			// Reviewer footer
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
				lines.push("");
				lines.push(footer);
			}

			return lines;
		},
		theme,
	);
}

/**
 * Legacy convenience: reads from `AgentRegistry.global()` so callers don't
 * need to thread the registry reference themselves.
 */
export function renderAgentPanelFromGlobalRegistry(swarmState: SwarmState | null | undefined, theme: Theme): Component {
	return renderAgentPanel(AgentRegistry.global().list(), swarmState, theme);
}

// ============================================================================
// Internal
// ============================================================================

type ToolUIStatus = "done" | "error" | "aborted" | "running" | "pending";

interface SwarmAgentMeta {
	status: string;
	iteration?: number;
	wave?: number;
	praiseCount?: number;
	error?: string;
	role?: string;
	modelName?: string;
	startedAt?: number;
	completedAt?: number;
}

function formatAgentLine(
	ref: AgentRef,
	swarmAgent: SwarmAgentMeta | undefined,
	innerWidth: number,
	theme: Theme,
): string {
	const displayStatus = swarmAgent?.status ?? ref.status;
	const iconStatus = STATUS_ICON[displayStatus] ?? "done";
	const glyph = formatStatusIcon(iconStatus, theme);
	const name = ref.displayName;

	// Kind badge: [sub] for subagents
	const kindBadge =
		ref.kind === "sub" ? theme.fg("dim", `${theme.format.bracketLeft}sub${theme.format.bracketRight}`) : "";

	// Role badge
	const roleLabel = ref.role ?? swarmAgent?.role ?? swarmAgent?.modelName ?? "";
	const roleBadge = roleLabel ? theme.fg("dim", `[${roleLabel}]`) : "";

	// Profile badge (credit score)
	let profileBadge = "";
	const profile = ref.session?.profile;
	if (profile) {
		profileBadge = theme.fg("dim", `score:${profile.credit.score}`);
	}

	// Swarm metrics
	let swarmMetrics = "";
	if (swarmAgent) {
		const parts: string[] = [];
		if ((swarmAgent.wave ?? 0) > 0) parts.push(`w${swarmAgent.wave}`);
		if ((swarmAgent.iteration ?? 0) > 0) parts.push(`i${swarmAgent.iteration}`);
		if ((swarmAgent.praiseCount ?? 0) > 0) parts.push(`👍${swarmAgent.praiseCount}`);
		if (parts.length > 0) swarmMetrics = theme.fg("muted", parts.join(" "));
	}

	// Status text
	let statusText: string;
	if (displayStatus === "failed") {
		const err = swarmAgent?.error ?? "unknown error";
		statusText = `${STATUS_LABEL[displayStatus] ?? displayStatus}: ${err}`;
	} else if (displayStatus === "idle") {
		statusText = theme.fg("success", STATUS_LABEL.idle);
	} else if (displayStatus === "running") {
		statusText = theme.fg("accent", STATUS_LABEL.running);
	} else {
		statusText = theme.fg("dim", STATUS_LABEL[displayStatus] ?? displayStatus);
	}

	// Duration
	let durationStr = "";
	if (swarmAgent?.startedAt) {
		const end = swarmAgent.completedAt ?? Date.now();
		const ms = end - swarmAgent.startedAt;
		durationStr = theme.fg("dim", `(${formatDuration(ms)})`);
	} else if (ref.status === "running" && ref.createdAt) {
		const ms = Date.now() - ref.createdAt;
		durationStr = theme.fg("dim", `(${formatDuration(ms)})`);
	}

	// Assemble
	const segments: string[] = [glyph, name];
	if (kindBadge) segments.push(kindBadge);
	if (roleBadge) segments.push(roleBadge);
	if (profileBadge) segments.push(profileBadge);
	if (swarmMetrics) segments.push(swarmMetrics);
	segments.push(statusText);
	if (durationStr) segments.push(durationStr);

	let line = ` ${segments.join(" ")}`;

	// Truncation if too long
	if (line.replace(/\x1b\[[0-9;]*m/g, "").length > innerWidth) {
		const minimal = ` ${glyph} ${name}`;
		const minimalLen = minimal.replace(/\x1b\[[0-9;]*m/g, "").length;
		const suffix = durationStr ? ` ${durationStr}` : "";
		const suffixLen = suffix.replace(/\x1b\[[0-9;]*m/g, "").length;
		const statusBudget = innerWidth - minimalLen - suffixLen - 1;

		if (displayStatus === "failed" && statusBudget > 10) {
			const err = swarmAgent?.error ?? "unknown error";
			const errBudget = statusBudget - "failed: ".length;
			if (errBudget >= 3) {
				const truncated = err.length > errBudget ? `${err.slice(0, errBudget - 3)}...` : err;
				line = `${minimal} ${theme.fg("error", `failed: ${truncated}`)}${suffix}`;
			} else {
				line = `${minimal}${suffix}`;
			}
		} else if (statusBudget >= 3) {
			const label = STATUS_LABEL[displayStatus] ?? displayStatus;
			const truncated = label.length > statusBudget ? `${label.slice(0, statusBudget - 3)}...` : label;
			line = `${minimal} ${theme.fg("dim", truncated)}${suffix}`;
		} else {
			line = `${minimal}${suffix}`;
		}
	}

	return line;
}

function formatDuration(ms: number): string {
	if (ms < 0) return "0s";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}h ${remainingMinutes}m`;
}

function buildAgentRefsFromSwarm(swarmState: SwarmState | null | undefined): AgentRef[] {
	if (!swarmState?.agents) return [];
	return Object.entries(swarmState.agents).map(([id, agent]) => ({
		id,
		displayName: id,
		status: (agent.status as AgentRef["status"]) ?? "idle",
		kind: "sub" as const,
		session: null,
		sessionFile: null,
		createdAt: agent.startedAt ?? 0,
		lastActivity: agent.startedAt ?? 0,
		role: agent.role,
	}));
}
