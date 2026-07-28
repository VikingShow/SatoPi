/**
 * Smoke tests for swarm TUI panels (post-unification).
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { renderAgentPanel } from "../../modes/components/swarm/agent-panel";
import { type CommMessage, renderCommPanel } from "../../modes/components/swarm/comm-panel";
import { type ContextPanelState, renderContextPanel } from "../../modes/components/swarm/context-panel";
import { getThemeByName, setThemeInstance, type Theme } from "../../modes/theme/theme";
import type { SwarmState } from "../core/state";

let theme: Theme;

beforeAll(async () => {
	const loaded = await getThemeByName("satopi");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
	theme = loaded;
});

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => (s ?? "").replace(ANSI_RE, "");

function makeSwarmState(overrides: Partial<SwarmState> = {}): SwarmState {
	return {
		name: "test-swarm", status: "running", mode: "loop",
		iteration: 0, targetCount: 4, agents: {}, startedAt: Date.now(),
		...overrides,
	};
}

// ============================================================================
// renderAgentPanel
// ============================================================================

describe("renderAgentPanel", () => {
	it("renders without crashing (empty agents)", () => {
		const state = makeSwarmState({ agents: {} });
		const lines = renderAgentPanel([], state, theme).render(72);
		expect(lines.length).toBeGreaterThan(0);
	});

	it("shows 'No agents' when empty", () => {
		const state = makeSwarmState({ agents: {} });
		const lines = renderAgentPanel([], state, theme).render(72);
		expect(stripAnsi(lines.join("\n"))).toContain("No agents");
	});

	it("shows agent names from swarm agents", () => {
		const state = makeSwarmState({
			agents: {
				"agent-1": { name: "agent-1", status: "running", iteration: 0, wave: 0, praiseCount: 0, criticismCount: 0, conflictCount: 0 },
			},
		});
		const lines = renderAgentPanel([], state, theme).render(72);
		expect(stripAnsi(lines.join("\n"))).toContain("agent-1");
	});

	it("has header 'Persistent Agents'", () => {
		const state = makeSwarmState({
			agents: {
				"agent-1": { name: "agent-1", status: "running", iteration: 0, wave: 0, praiseCount: 0, criticismCount: 0, conflictCount: 0 },
			},
		});
		const lines = renderAgentPanel([], state, theme).render(72);
		expect(stripAnsi(lines[0])).toContain("Persistent Agents");
	});

	it("filters to persistent-only agents (swarm agents have kind=persistent in fallback)", () => {
		const state = makeSwarmState({
			agents: {
				"agent-1": { name: "agent-1", status: "completed", iteration: 0, wave: 0, praiseCount: 0, criticismCount: 0, conflictCount: 0 },
			},
		});
		const lines = renderAgentPanel([], state, theme).render(72);
		expect(stripAnsi(lines.join("\n"))).toContain("agent-1");
	});
});

// ============================================================================
// renderCommPanel
// ============================================================================

describe("renderCommPanel", () => {
	const makeMsg = (overrides: Partial<CommMessage> = {}): CommMessage => ({
		timestamp: Date.now(), from: "human", to: "planner", body: "test", ...overrides,
	});

	it("shows 'No messages' when empty", () => {
		const lines = renderCommPanel([], theme).render(72);
		expect(stripAnsi(lines.join("\n"))).toContain("No messages");
	});

	it("formats sender, body, and direction", () => {
		const msg = makeMsg({ from: "human", to: "planner", body: "hello" });
		const full = renderCommPanel([msg], theme).render(72).join("\n");
		expect(full).toContain("human");
		expect(full).toContain("planner");
		expect(full).toContain("hello");
	});
});

// ============================================================================
// renderContextPanel
// ============================================================================

describe("renderContextPanel", () => {
	const makeCtx = (overrides: Partial<ContextPanelState> = {}): ContextPanelState => ({
		sources: [], l1PendingCount: 0, l2LastFlushSeconds: 0, l3Nodes: 0, l3Edges: 0, agents: [], ...overrides,
	});

	it("shows source names", () => {
		const state = makeCtx({ sources: [{ name: "TestSource", active: true }] });
		const lines = renderContextPanel(state, theme).render(72);
		expect(stripAnsi(lines.join("\n"))).toContain("TestSource");
	});

	it("shows 'No context data' when empty", () => {
		const state = makeCtx();
		const lines = renderContextPanel(state, theme).render(72);
		expect(stripAnsi(lines.join("\n"))).toContain("No context data");
	});
});
