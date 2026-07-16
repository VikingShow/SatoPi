/**
 * TUI progress rendering for swarm pipeline status.
 */
import { formatDuration, truncate } from "@oh-my-pi/pi-utils";
import type { AgentState, SwarmState } from "./state";

const STATUS_LABELS: Record<string, string> = {
	completed: "[done]",
	running: "[....]",
	failed: "[FAIL]",
	pending: "[    ]",
	waiting: "[wait]",
	idle: "[idle]",
	aborted: "[stop]",
};

export function renderSwarmProgress(state: SwarmState): string[] {
	const lines: string[] = [];
	const isLoop = state.mode === "loop";

	// Header
	const statusLabel = state.status.toUpperCase();
	lines.push(`Swarm: ${state.name} [${statusLabel}]`);
	if (isLoop) {
		const phase = state.roundtablePhase ?? "Initializing";
		const iterInfo = state.loopIteration != null
			? `Iter ${state.loopIteration}/${state.targetCount}`
			: "";
		lines.push(`Mode: loop | Phase: ${phase} | ${iterInfo}`);
	} else {
		lines.push(`Mode: ${state.mode} | Iteration: ${state.iteration + 1}/${state.targetCount}`);
	}
	lines.push("");

	const agents: AgentState[] = Object.values(state.agents);
	if (agents.length === 0) {
		lines.push("  (no agents)");
		return lines;
	}

	if (isLoop) {
		// Group: Workers, then Cloners
		const workers = agents.filter(a => a.name.startsWith("worker-"));
		const cloners = agents.filter(a => a.name.startsWith("cloner-"));

		if (workers.length > 0) {
			const wSummary = summarizeGroup(workers);
			lines.push(`  Workers (${workers.length}): ${wSummary}`);
			for (const w of workers) {
				lines.push(`    ${formatAgentLine(w)}`);
			}
		}
		if (cloners.length > 0) {
			const cSummary = summarizeGroup(cloners);
			lines.push(`  Cloners (${cloners.length}): ${cSummary}`);
			for (const c of cloners) {
				lines.push(`    ${formatAgentLine(c)}`);
			}
		}

		// Review verdict summary
		if (state.reviewVerdict) {
			lines.push("");
			lines.push(`  Findings: ${truncate(state.reviewVerdict, 80)}`);
		}
	} else {
		// Non-loop: flat list
		for (const agent of agents) {
			lines.push(`  ${formatAgentLine(agent)}`);
		}
	}

	// Summary footer
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
	lines.push(`  ${parts.join(" | ")}`);

	return lines;
}

function formatAgentDuration(agent: { startedAt?: number; completedAt?: number; status: string }): string {
	if (agent.startedAt && agent.completedAt) {
		return ` (${formatDuration(agent.completedAt - agent.startedAt)})`;
	}
	if (agent.startedAt && (agent.status === "running" || agent.status === "waiting")) {
		return ` (${formatDuration(Date.now() - agent.startedAt)}...)`;
	}
	return "";
}

// -- Helpers --

function formatAgentLine(agent: AgentState): string {
	const icon = STATUS_LABELS[agent.status] ?? "[????]";
	const dur = formatAgentDuration(agent);
	const err = agent.error ? ` - ${truncate(agent.error, 40)}` : "";
	return `${icon} ${agent.name}: ${agent.status}${dur}${err}`;
}

function summarizeGroup(agents: AgentState[]): string {
	const done = agents.filter(a => a.status === "completed").length;
	const running = agents.filter(a => a.status === "running").length;
	const failed = agents.filter(a => a.status === "failed").length;
	const parts = [`${done} done`];
	if (running > 0) parts.push(`${running} running`);
	if (failed > 0) parts.push(`${failed} failed`);
	return parts.join(", ");
}
