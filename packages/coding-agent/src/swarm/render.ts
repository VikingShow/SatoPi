/**
 * TUI progress rendering for swarm pipeline status.
 *
 * Produces ANSI-color-coded lines for terminal display.
 */
import { formatDuration, truncate } from "@oh-my-pi/pi-utils";
import type { AgentState, SwarmState } from "./state";

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------

const C = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	red: "\x1b[31m",
	gray: "\x1b[90m",
};

function color(status: AgentState["status"], text: string): string {
	switch (status) {
		case "completed":
			return `${C.green}${text}${C.reset}`;
		case "running":
			return `${C.yellow}${text}${C.reset}`;
		case "failed":
			return `${C.red}${text}${C.reset}`;
		case "waiting":
			return `${C.cyan}${text}${C.reset}`;
		default:
			return `${C.dim}${text}${C.reset}`;
	}
}

// ---------------------------------------------------------------------------
// Status glyphs
// ---------------------------------------------------------------------------

const STATUS_GLYPHS: Record<string, string> = {
	completed: "✓",
	running: "◌",
	failed: "✗",
	pending: "○",
	waiting: "◷",
	idle: "·",
	aborted: "⊘",
};

function statusGlyph(status: AgentState["status"]): string {
	return STATUS_GLYPHS[status] ?? "?";
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

export function renderSwarmProgress(state: SwarmState): string[] {
	const lines: string[] = [];
	const isLoop = state.mode === "loop";
	const agents = Object.values(state.agents);

	// Header
	const statusColor =
		state.status === "running"
			? C.yellow
			: state.status === "completed"
				? C.green
				: state.status === "failed"
					? C.red
					: C.dim;
	lines.push(`${C.bold}Swarm: ${state.name}${C.reset} ${statusColor}[${state.status.toUpperCase()}]${C.reset}`);

	if (isLoop) {
		const iter = state.loopIteration != null ? `${state.loopIteration}/${state.targetCount}` : "—";
		const phase = state.roundtablePhase ?? "Initializing";
		lines.push(`${C.dim}Loop  ${iter}  │  ${phase}${C.reset}`);
	} else {
		lines.push(`${C.dim}Mode: ${state.mode}  │  Iteration: ${state.iteration + 1}/${state.targetCount}${C.reset}`);
	}

	if (agents.length === 0) {
		lines.push(`  ${C.dim}(no agents)${C.reset}`);
		return finish(lines, agents, state);
	}

	if (isLoop) {
		const agents = agents.filter(a => a.name.startsWith("agent-"));
		const reviewers = agents.filter(a => a.name.startsWith("agent-"));

		// Workers section
		if (workers.length > 0) {
			const wDone = workers.filter(a => a.status === "completed").length;
			const wRun = workers.filter(a => a.status === "running").length;
			const wFail = workers.filter(a => a.status === "failed").length;
			const reviewer = workers.find(w => w.role === "reviewer");
			const reviewerTag = reviewer ? `  ${C.magenta}👑 reviewer: ${reviewer.name}${C.reset}` : "";
			lines.push(
				`  ${C.bold}Agents${C.reset} (${workers.length}): ${C.green}${wDone} done${C.reset}${wRun > 0 ? ` ${C.yellow}${wRun} running${C.reset}` : ""}${wFail > 0 ? ` ${C.red}${wFail} failed${C.reset}` : ""}${reviewerTag}`,
			);
			for (const w of workers) {
				lines.push(`    ${formatAgentLine(w)}`);
			}
		}

		// Cloners section (only when active)
		if (cloners.length > 0 && cloners.some(c => c.status !== "pending")) {
			const cDone = cloners.filter(a => a.status === "completed").length;
			const cRun = cloners.filter(a => a.status === "running").length;
			lines.push(
				`  ${C.bold}Reviewers${C.reset} (${cloners.length}): ${cDone} done${cRun > 0 ? ` ${cRun} running` : ""}`,
			);
			for (const c of cloners) {
				lines.push(`    ${formatAgentLine(c)}`);
			}
		}

		// Verdict
		if (state.reviewVerdict) {
			const isPass = state.reviewVerdict.toLowerCase().includes("pass") || state.reviewVerdict === "swarm consensus";
			const verdictColor = isPass ? C.green : C.yellow;
			lines.push(`  ${verdictColor}▶ ${truncate(state.reviewVerdict, 80)}${C.reset}`);
		}

		// Conflict summary
		const conflictCount = workers.reduce((sum, w) => sum + w.conflictCount, 0);
		if (conflictCount > 0) {
			lines.push(`  ${C.red}⚠ ${conflictCount} file conflict${conflictCount > 1 ? "s" : ""} detected${C.reset}`);
		}
	} else {
		// Pipeline mode: simple flat list
		for (const agent of agents) {
			lines.push(`  ${formatAgentLine(agent)}`);
		}
	}

	return finish(lines, agents, state);
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function finish(lines: string[], agents: AgentState[], state: SwarmState): string[] {
	const completed = agents.filter(a => a.status === "completed").length;
	const failed = agents.filter(a => a.status === "failed").length;
	const running = agents.filter(a => a.status === "running").length;

	lines.push("");
	const parts = [`${completed}/${agents.length} done`];
	if (running > 0) parts.push(`${running} running`);
	if (failed > 0) parts.push(`${failed} failed`);
	if (state.startedAt) {
		parts.push(`elapsed: ${formatDuration(Date.now() - state.startedAt)}`);
	}
	lines.push(`${C.dim}  ${parts.join(" │ ")}${C.reset}`);

	return lines;
}

// ---------------------------------------------------------------------------
// Agent line formatting
// ---------------------------------------------------------------------------

function formatAgentLine(agent: AgentState): string {
	const glyph = statusGlyph(agent.status);
	const coloredGlyph = color(agent.status, glyph);
	const dur = formatAgentDuration(agent);
	const roleTag = agent.role === "reviewer" ? ` ${C.magenta}[R]${C.reset}` : "";
	const conflictTag = agent.conflictCount > 0 ? ` ${C.red}⚠${agent.conflictCount}${C.reset}` : "";
	const err = agent.error ? ` ${C.red}${truncate(agent.error, 40)}${C.reset}` : "";

	return `${coloredGlyph} ${agent.name}${roleTag} ${dur}${conflictTag}${err}`;
}

function formatAgentDuration(agent: { startedAt?: number; completedAt?: number; status: string }): string {
	if (agent.startedAt && agent.completedAt) {
		return `${C.dim}(${formatDuration(agent.completedAt - agent.startedAt)})${C.reset}`;
	}
	if (agent.startedAt && (agent.status === "running" || agent.status === "waiting")) {
		return `${C.yellow}(${formatDuration(Date.now() - agent.startedAt)}...)${C.reset}`;
	}
	return "";
}
