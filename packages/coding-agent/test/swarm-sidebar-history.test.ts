/**
 * SwarmSidebar History section contracts:
 * - History sessions render with an agent-count badge; Enter on a history
 *   session expands its persisted agent tree (Space toggles too), Enter on
 *   the History root collapses, and `r` resumes the session.
 * - Persisted agents render as a nested parentId tree: container agents
 *   (sub-sessions with their own children) show an expand/collapse glyph and
 *   toggle on Enter, leaf agents open on Enter, advisors are never listed.
 * - The framed panel fits the overlay budget so the bottom border is visible.
 *
 * The sidebar is a plain Component: render(width) and handleInput(data) are
 * driven directly (no TUI). listSessions is stubbed; loadSessionAgents runs
 * the real collectPersistedAgents scan over on-disk fixtures, so waits yield
 * to the event loop for real FS I/O.
 */
import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { collectPersistedAgents, type PersistedAgentInfo } from "@satopi/pi-coding-agent/modes/components/agent-hub";
import { SwarmSidebar } from "@satopi/pi-coding-agent/modes/components/swarm/swarm-sidebar";
import { initTheme, theme } from "@satopi/pi-coding-agent/modes/theme/theme";
import { MAIN_AGENT_ID } from "@satopi/pi-coding-agent/registry/agent-registry";
import type { SessionInfo } from "@satopi/pi-coding-agent/session/session-listing";
import { TempDir } from "@satopi/pi-utils";

const strip = (line: string): string => Bun.stripANSI(line);

interface Fixture {
	dir: TempDir;
	/** Session with a nested agent tree: alpha → bravo, root sierra1, plus an advisor. */
	sessionA: string;
	/** Session with a single leaf agent. */
	sessionB: string;
	/** The sidebar's own session (excluded from History). */
	current: string;
}

async function makeFixture(): Promise<Fixture> {
	const dir = TempDir.createSync("@swarm-sidebar-history-");
	const mkdir = (p: string) => fs.mkdir(path.join(dir.path(), p), { recursive: true });
	await mkdir("alpha/alpha");
	await mkdir("alpha/swarm-x/agents");
	await mkdir("beta");
	await Bun.write(path.join(dir.path(), "alpha", "alpha.jsonl"), "{}");
	await Bun.write(path.join(dir.path(), "alpha", "alpha", "bravo.jsonl"), "{}");
	await Bun.write(path.join(dir.path(), "alpha", "swarm-x", "agents", "sierra1.jsonl"), "{}");
	await Bun.write(path.join(dir.path(), "alpha", "__advisor.jsonl"), "{}");
	await Bun.write(path.join(dir.path(), "alpha", "skip.jsonl.bak"), "{}");
	await Bun.write(path.join(dir.path(), "beta", "charlie.jsonl"), "{}");
	return {
		dir,
		sessionA: path.join(dir.path(), "alpha.jsonl"),
		sessionB: path.join(dir.path(), "beta.jsonl"),
		current: path.join(dir.path(), "current.jsonl"),
	};
}

function sessionInfo(sessionFile: string, title: string): SessionInfo {
	return {
		path: sessionFile,
		id: sessionFile,
		cwd: "",
		title,
		created: new Date(0),
		modified: new Date(1000),
		messageCount: 0,
		size: 0,
		firstMessage: "",
		allMessagesText: "",
	};
}

interface Harness {
	sidebar: SwarmSidebar;
	onResumeSession: Mock<(sessionFile: string) => void>;
	onOpenHistoryAgent: Mock<(agent: PersistedAgentInfo) => void>;
	onRequestRender: Mock<() => void>;
}

function makeHarness(fx: Fixture): Harness {
	const onResumeSession = vi.fn<(sessionFile: string) => void>();
	const onOpenHistoryAgent = vi.fn<(agent: PersistedAgentInfo) => void>();
	const onRequestRender = vi.fn<() => void>();
	const sidebar = new SwarmSidebar(
		{
			sessionFile: fx.current,
			listSessions: async () => [sessionInfo(fx.sessionA, "Session One"), sessionInfo(fx.sessionB, "Session Two")],
			loadSessionAgents: sessionFile => collectPersistedAgents(sessionFile),
			onResumeSession,
			onOpenHistoryAgent,
			onRequestRender,
			crewManager: undefined,
		},
		theme,
	);
	return { sidebar, onResumeSession, onOpenHistoryAgent, onRequestRender };
}

const rendered = (sidebar: SwarmSidebar): string[] => sidebar.render(120).map(strip);

/** Flat index of the row whose stripped text contains `label` (line 0 = frame top bar). */
function flatIndexOf(lines: readonly string[], label: string): number {
	const idx = lines.findIndex(line => line.includes(label));
	expect(idx, `a row containing ${JSON.stringify(label)}`).toBeGreaterThan(0);
	return idx - 1;
}

/** Park selection at the top, then step down to `flatIndex`. */
function selectRow(sidebar: SwarmSidebar, flatIndex: number): void {
	for (let i = 0; i < 40; i++) sidebar.handleInput("k");
	for (let i = 0; i < flatIndex; i++) sidebar.handleInput("j");
}

/**
 * Yield to the event loop until `check()` holds. The sidebar's #loadSessions
 * and #ensureHistoryAgents are fire-and-forget and their promises are never
 * exposed, and summarizePersistedAgents/collectPersistedAgents do real
 * node:fs I/O whose completions only arrive after an event-loop turn — fake
 * timers and microtask flushing cannot deliver them, so a short poll against
 * the platform clock is the only deterministic signal available here.
 */
async function waitFor(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (check()) return;
		await Bun.sleep(1);
	}
	throw new Error(`timed out waiting for: ${what}`);
}
async function expandHistory(h: Harness): Promise<void> {
	await waitFor(() => rendered(h.sidebar).some(l => l.includes("History")), "History root row");
	selectRow(h.sidebar, flatIndexOf(rendered(h.sidebar), "History"));
	h.sidebar.handleInput("\n");
}

/** History root + Session One expanded, persisted agents loaded. */
async function expandSessionA(h: Harness): Promise<void> {
	await expandHistory(h);
	selectRow(h.sidebar, flatIndexOf(rendered(h.sidebar), "Session One"));
	h.sidebar.handleInput("\n");
	await waitFor(() => rendered(h.sidebar).some(l => l.includes("alpha")), "agent load");
}

describe("SwarmSidebar history", () => {
	let fx: Fixture;
	const sidebars: SwarmSidebar[] = [];

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		for (const sidebar of sidebars.splice(0)) sidebar.dispose();
		fx?.dir.removeSync();
	});

	async function newHarness(): Promise<Harness> {
		fx = await makeFixture();
		const h = makeHarness(fx);
		sidebars.push(h.sidebar);
		return h;
	}

	it("renders other sessions with an agent-count badge once summarized", async () => {
		const h = await newHarness();
		await expandHistory(h);
		// Summaries load sequentially per session — wait until both badges land.
		await waitFor(
			() =>
				rendered(h.sidebar).some(l => l.includes("3 agents")) &&
				rendered(h.sidebar).some(l => l.includes("1 agent")),
			"both session badges",
		);
		const lines = rendered(h.sidebar);
		expect(lines.some(l => l.includes("Session One") && l.includes("3 agents"))).toBe(true);
		expect(lines.some(l => l.includes("Session Two") && l.includes("1 agent"))).toBe(true);
	});

	it("expands a history session on Enter, with nested agents only after expanding the container", async () => {
		const h = await newHarness();
		await expandSessionA(h);

		const before = rendered(h.sidebar);
		expect(before.some(l => l.includes("alpha"))).toBe(true);
		expect(before.some(l => l.includes("bravo"))).toBe(false);
		expect(before.some(l => l.includes("advisor"))).toBe(false);
		// alpha is a container: shows the collapsed marker.
		const alphaIdx = flatIndexOf(before, "alpha");
		expect(before[alphaIdx + 1]).toContain("\u25b6");

		selectRow(h.sidebar, alphaIdx);
		h.sidebar.handleInput("\n");
		const after = rendered(h.sidebar);
		expect(after.some(l => l.includes("bravo"))).toBe(true);
		expect(after.find(l => l.includes("alpha"))).toContain("\u25bc");
		expect(h.onResumeSession).not.toHaveBeenCalled();
	});

	it("resumes a history session on r, not on Enter", async () => {
		const h = await newHarness();
		await expandHistory(h);
		selectRow(h.sidebar, flatIndexOf(rendered(h.sidebar), "Session One"));
		h.sidebar.handleInput("\n"); // Enter expands, never resumes
		expect(h.onResumeSession).not.toHaveBeenCalled();
		h.sidebar.handleInput("r"); // selection is still on Session One
		expect(h.onResumeSession).toHaveBeenCalledTimes(1);
		expect(h.onResumeSession).toHaveBeenCalledWith(fx.sessionA);
	});

	it("opens a leaf history agent on Enter with its PersistedAgentInfo", async () => {
		const h = await newHarness();
		await expandSessionA(h);
		// sierra1 is a root-level leaf (parent = main agent, no children).
		selectRow(h.sidebar, flatIndexOf(rendered(h.sidebar), "sierra1"));
		h.sidebar.handleInput("\n");
		expect(h.onOpenHistoryAgent).toHaveBeenCalledTimes(1);
		const info = h.onOpenHistoryAgent.mock.calls[0]?.[0];
		expect(info).toMatchObject({ id: "sierra1", kind: "sub", parentId: MAIN_AGENT_ID });
		expect(info.sessionFile.endsWith(path.join("alpha", "swarm-x", "agents", "sierra1.jsonl"))).toBe(true);
	});

	it("fits the framed panel in the overlay budget with the bottom border visible", async () => {
		const h = await newHarness();
		const termRows = process.stdout.rows || 24;
		const lines = h.sidebar.render(120);
		expect(lines.length).toBeLessThanOrEqual(termRows - 2);
		const lastNonEmpty = [...lines].reverse().find(l => strip(l).trim() !== "");
		expect(strip(lastNonEmpty ?? "")).toMatch(/╰|└/);
	});
});
