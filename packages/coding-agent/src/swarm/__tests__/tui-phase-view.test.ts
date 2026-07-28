/**
 * Unit tests for SatoPi TUI phase lifecycle view (post-unification).
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { renderPhaseView } from "../../modes/components/swarm/phase-view";
import { getThemeByName, setThemeInstance, type Theme } from "../../modes/theme/theme";
import type { Chapter, SwarmState } from "../core/state";

let theme: Theme;

beforeAll(async () => {
	const loaded = await getThemeByName("satopi");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
	theme = loaded;
});

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => (s ?? "").replace(ANSI_RE, "");

function makeState(overrides: Partial<SwarmState> = {}): SwarmState {
	return {
		name: "test-swarm", status: "running", mode: "loop", iteration: 0,
		targetCount: 3, agents: {}, startedAt: Date.now() - 60_000,
		phase: "script", ...overrides,
	} as SwarmState;
}

describe("renderPhaseView", () => {
	it("returns two lines for every phase", () => {
		for (const phase of ["idle", "script", "stage", "curtain"] as Chapter[]) {
			const state = makeState({ phase });
			const lines = renderPhaseView(state, theme);
			expect(lines.length).toBe(2);
		}
	});

	it("contains phase labels", () => {
		const state = makeState({ phase: "stage" });
		const lines = renderPhaseView(state, theme);
		const plain = stripAnsi(lines[0]);
		expect(plain).toContain("Idle");
		expect(plain).toContain("Script");
		expect(plain).toContain("Stage");
	});

	it("defaults to idle when phase is undefined", () => {
		const state = makeState({ phase: undefined as unknown as Chapter });
		const lines = renderPhaseView(state, theme);
		expect(stripAnsi(lines[0])).toContain("Idle");
	});

	it("sub-status line shows status text", () => {
		const state = makeState({ phase: "stage", status: "running" });
		const lines = renderPhaseView(state, theme);
		expect(stripAnsi(lines[1]).toLowerCase()).toContain("running");
	});

	it("sub-status line shows task progress", () => {
		const state = makeState({
			phase: "stage",
			todos: [
				{ id: "1", content: "a", status: "done" as const, phase: "" },
				{ id: "2", content: "b", status: "pending" as const, phase: "" },
			],
		});
		const lines = renderPhaseView(state, theme);
		expect(stripAnsi(lines[1])).toContain("1/2");
	});
});
