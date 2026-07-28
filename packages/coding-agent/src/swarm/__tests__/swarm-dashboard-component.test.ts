/**
 * SwarmDashboardComponent unit tests — verify reference-equality caching
 * (the precondition for differential repaint) and snapshot updates.
 */

import { describe, expect, it } from "bun:test";
import type { DashboardInput } from "../../modes/components/swarm/swarm-dashboard";
import { SwarmDashboardComponent } from "../../modes/components/swarm/swarm-dashboard-component";
import type { SwarmState } from "../core/state";

function snapshot(phase: SwarmState["phase"] = "stage"): DashboardInput {
	const swarm: SwarmState = {
		name: "demo",
		status: "running",
		mode: "loop",
		iteration: 1,
		targetCount: 1,
		agents: {},
		startedAt: 0,
		phase,
	};
	return {
		agents: [],
		swarm,
		messages: [],
		context: { sources: [], l1PendingCount: 0, l2LastFlushSeconds: 0, l3Nodes: 0, l3Edges: 0, agents: [] },
	};
}

describe("SwarmDashboardComponent", () => {
	it("renders an empty array when there is no snapshot", () => {
		const c = new SwarmDashboardComponent();
		expect(c.render(80)).toEqual([]);
	});

	it("returns the SAME array reference for repeated same-width renders (diff-skip)", () => {
		const c = new SwarmDashboardComponent(snapshot());
		const first = c.render(80);
		const second = c.render(80);
		expect(second).toBe(first); // reference equality → engine skips repaint
	});

	it("recomputes (new reference) when the width changes", () => {
		const c = new SwarmDashboardComponent(snapshot());
		const at80 = c.render(80);
		const at120 = c.render(120);
		expect(at120).not.toBe(at80);
	});

	it("invalidates the cache on update()", () => {
		const c = new SwarmDashboardComponent(snapshot("stage"));
		const before = c.render(80);
		c.update(snapshot("curtain"));
		const after = c.render(80);
		expect(after).not.toBe(before);
	});
});
