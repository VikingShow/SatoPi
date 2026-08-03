import { beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { collectPersistedAgents, type PersistedAgentInfo } from "@satopi/pi-coding-agent/modes/components/agent-hub";
import { SessionSelectorComponent } from "@satopi/pi-coding-agent/modes/components/session-selector";
import { initTheme } from "@satopi/pi-coding-agent/modes/theme/theme";
import { MAIN_AGENT_ID } from "@satopi/pi-coding-agent/registry/agent-registry";
import type { SessionInfo } from "@satopi/pi-coding-agent/session/session-listing";
import { TempDir } from "@satopi/pi-utils";

/**
 * Phase-3 resume-picker contracts (SessionSelectorComponent): per-row `N
 * agents` badges, `l` inline expansion of a session's persisted agents (flat,
 * indented rows), Enter on an agent row quick-jumping via `onOpenAgent`
 * (register + focus), and Enter on a session row resuming unchanged.
 *
 * No production change was needed for this test: SessionSelectorComponent
 * already implements `handleInput` (forwarding every key to its private
 * SessionList, which owns the `l` → #toggleExpanded and Enter quick-jump
 * paths), so the test drives everything through the component's public input
 * path.
 *
 * The badge scan (`summarizePersistedAgents`) and the agent-list collection
 * (`collectPersistedAgents`, wired through the `loadSessionAgents` option)
 * walk the real filesystem, so the fixtures are real temp-dir transcripts —
 * no mocks. Async completions are awaited through the component's own
 * `onRequestRender` signal (the real completion event), never wall-clock
 * sleeps.
 */

const RENDER_WIDTH = 80;

/** Disk layout under test (real files; the session `.jsonl` itself need not exist): */
function makeFixture(dir: TempDir): { sessionA: SessionInfo; sessionB: SessionInfo; agent1File: string } {
	const dirA = path.join(dir.path(), "sessionA");
	const dirB = path.join(dir.path(), "sessionB");
	fs.mkdirSync(path.join(dirA, "agent1"), { recursive: true });
	fs.mkdirSync(dirB, { recursive: true });
	fs.writeFileSync(path.join(dirA, "agent1.jsonl"), '{"role":"user","content":"a"}\n');
	fs.writeFileSync(path.join(dirA, "agent1", "agent2.jsonl"), '{"role":"user","content":"b"}\n');
	const sessionA: SessionInfo = {
		path: path.join(dir.path(), "sessionA.jsonl"),
		id: "session-a",
		cwd: "/repo",
		title: "Session A",
		created: new Date(1700000000000),
		modified: new Date(1700000002000),
		messageCount: 1,
		size: 64,
		firstMessage: "alpha session",
		allMessagesText: "alpha session",
	};
	const sessionB: SessionInfo = {
		path: path.join(dir.path(), "sessionB.jsonl"),
		id: "session-b",
		cwd: "/repo",
		title: "Session B",
		created: new Date(1700000001000),
		modified: new Date(1700000001000),
		messageCount: 1,
		size: 64,
		firstMessage: "beta session",
		allMessagesText: "beta session",
	};
	return { sessionA, sessionB, agent1File: path.join(dirA, "agent1.jsonl") };
}

interface Harness {
	component: SessionSelectorComponent;
	onSelect: Mock<(session: SessionInfo) => void>;
	onCancel: Mock<() => void>;
	onExit: Mock<() => void>;
	onOpenAgent: Mock<(agent: PersistedAgentInfo) => void>;
	/** Dispatch a raw terminal key sequence through the picker's input path. */
	press: (key: string) => void;
	/** Current render, ANSI stripped, one string per row. */
	lines: () => string[];
	/** Current render, ANSI stripped, joined by newlines. */
	text: () => string;
	/** Resolves on the next `onRequestRender` firing after the call. */
	awaitNextRender: () => Promise<void>;
}

function makeHarness(sessions: SessionInfo[]): Harness {
	const onSelect = vi.fn();
	const onCancel = vi.fn();
	const onExit = vi.fn();
	const onOpenAgent = vi.fn();
	const component = new SessionSelectorComponent(sessions, onSelect, onCancel, onExit, {
		loadSessionAgents: sessionFile => collectPersistedAgents(sessionFile),
		onOpenAgent,
		getTerminalRows: () => 24,
	});
	const renderWaiters: (() => void)[] = [];
	component.setOnRequestRender(() => {
		while (renderWaiters.length > 0) renderWaiters.shift()!();
	});
	return {
		component,
		onSelect,
		onCancel,
		onExit,
		onOpenAgent,
		press: key => component.handleInput(key),
		lines: () => component.render(RENDER_WIDTH).map(line => Bun.stripANSI(line)),
		text: () =>
			component
				.render(RENDER_WIDTH)
				.map(line => Bun.stripANSI(line))
				.join("\n"),
		awaitNextRender: () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			renderWaiters.push(resolve);
			return promise;
		},
	};
}

/**
 * Wait until the live render satisfies `predicate`, consuming the picker's
 * `onRequestRender` completion events. The awaited work is real disk I/O
 * (summary scan / agent-list collection), so each awaited event lets the
 * event loop finish the in-flight operation; the synchronous `l`-toggle
 * render and any early-arriving badge render are absorbed by the predicate
 * re-check rather than by counting events.
 */
async function settle(harness: Harness, predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 32; attempt++) {
		if (predicate()) return;
		await harness.awaitNextRender();
	}
	expect(predicate()).toBe(true);
}

beforeAll(async () => {
	await initTheme(false);
});

describe("session selector persisted-agent quick-jump", () => {
	it("badges the session that has persisted agents and leaves the empty one compact", async () => {
		using dir = TempDir.createSync("@pi-session-selector-");
		const fixture = makeFixture(dir);
		const harness = makeHarness([fixture.sessionA, fixture.sessionB]);

		// The summary scan is async disk I/O; settle on the real completion signal.
		await settle(harness, () => harness.text().includes("2 agents"));

		const lines = harness.lines();
		expect(lines.filter(line => line.includes("agents"))).toEqual([expect.stringContaining("2 agents")]);
		const titleA = lines.findIndex(line => line.includes("Session A"));
		const titleB = lines.findIndex(line => line.includes("Session B"));
		expect(titleA).toBeGreaterThanOrEqual(0);
		expect(titleB).toBeGreaterThan(titleA);
		const badgeIndex = lines.findIndex(line => line.includes("2 agents"));
		expect(badgeIndex).toBeGreaterThan(titleA);
		expect(badgeIndex).toBeLessThan(titleB);
		// Session B's block never mentions agents; the badge is A-only.
		expect(lines.slice(titleB).join("\n")).not.toMatch(/agent/);
	});

	it("`l` expands the selected session's persisted agents inline (flat) and `l` again collapses", async () => {
		using dir = TempDir.createSync("@pi-session-selector-");
		const fixture = makeFixture(dir);
		const harness = makeHarness([fixture.sessionA, fixture.sessionB]);
		await settle(harness, () => harness.text().includes("2 agents"));

		harness.press("l");
		// Both persisted agents appear flat under session A (the inline list is
		// not nested — agent2 is a sibling row of agent1, not a child of it).
		await settle(harness, () => harness.text().includes("agent1") && harness.text().includes("agent2"));

		const lines = harness.lines();
		const titleA = lines.findIndex(line => line.includes("Session A"));
		const titleB = lines.findIndex(line => line.includes("Session B"));
		const agentLines = lines.filter(line => line.includes("agent1") || line.includes("agent2"));
		expect(agentLines).toHaveLength(2);
		for (const line of agentLines) {
			expect(line.startsWith("  ")).toBe(true); // indented inline row
			const index = lines.indexOf(line);
			expect(index).toBeGreaterThan(titleA); // inside A's block
			expect(index).toBeLessThan(titleB); // flat — both above B's title
		}

		// `l` again collapses: synchronous state change, rows vanish immediately.
		harness.press("l");
		const collapsed = harness.lines();
		expect(collapsed.some(line => line.includes("agent1") || line.includes("agent2"))).toBe(false);
	});

	it("Enter on an expanded agent row quick-jumps via onOpenAgent", async () => {
		using dir = TempDir.createSync("@pi-session-selector-");
		const fixture = makeFixture(dir);
		const harness = makeHarness([fixture.sessionA, fixture.sessionB]);
		await settle(harness, () => harness.text().includes("2 agents"));

		harness.press("l");
		await settle(harness, () => harness.text().includes("agent1") && harness.text().includes("agent2"));

		// The flat rows render in collectPersistedAgents order (readdir order,
		// filesystem-dependent), so find which row is agents[0] and step the
		// agent cursor onto agent1 wherever it sits.
		const agentLines = harness.lines().filter(line => line.includes("agent1") || line.includes("agent2"));
		expect(agentLines).toHaveLength(2);
		const firstIsAgent1 = agentLines[0]!.includes("agent1") && !agentLines[0]!.includes("agent2");
		harness.press("\x1b[B"); // descend from the session row into agents[0]
		if (!firstIsAgent1) harness.press("\x1b[B"); // step onto agent1
		harness.press("\r");

		expect(harness.onOpenAgent).toHaveBeenCalledTimes(1);
		expect(harness.onOpenAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "agent1",
				displayName: "agent1",
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				sessionFile: fixture.agent1File,
			}),
		);
		expect(harness.onSelect).not.toHaveBeenCalled();
	});

	it("Enter on a session row resumes the session unchanged", async () => {
		using dir = TempDir.createSync("@pi-session-selector-");
		const fixture = makeFixture(dir);
		const harness = makeHarness([fixture.sessionA, fixture.sessionB]);

		harness.press("\r");

		expect(harness.onSelect).toHaveBeenCalledTimes(1);
		expect(harness.onSelect).toHaveBeenCalledWith(fixture.sessionA);
		expect(harness.onOpenAgent).not.toHaveBeenCalled();
		expect(harness.onCancel).not.toHaveBeenCalled();
	});
});
