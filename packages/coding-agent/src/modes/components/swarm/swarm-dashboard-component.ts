/**
 * SwarmDashboardComponent — pi-tui Component wrapper around the swarm dashboard.
 *
 * The dashboard render functions (agent/comm/context/phase panels) are pure
 * `(snapshot, width) → string[]` helpers. This component adapts them to the
 * pi-tui Component contract so the swarm dashboard can mount in the interactive
 * TUI tree and benefit from differential rendering.
 *
 * Reference-equality caching: when the snapshot and width are unchanged, render
 * returns the *same* array reference, which the engine treats as "no change" and
 * skips repainting. `update()` swaps the snapshot and invalidates the cache.
 */

import type { Component } from "@oh-my-pi/pi-tui";
import { type DashboardInput, renderDashboard } from "./swarm-dashboard";

export class SwarmDashboardComponent implements Component {
	#snapshot: DashboardInput | null;
	#cache: readonly string[] | null = null;
	#cacheWidth = -1;

	constructor(snapshot: DashboardInput | null = null) {
		this.#snapshot = snapshot;
	}

	/** Replace the rendered snapshot and force a repaint on next frame. */
	update(snapshot: DashboardInput): void {
		this.#snapshot = snapshot;
		this.invalidate();
	}

	invalidate(): void {
		this.#cache = null;
		this.#cacheWidth = -1;
	}

	render(width: number): readonly string[] {
		// Same snapshot + same width → return the cached reference so the engine
		// diff skips this component entirely.
		if (this.#cache !== null && this.#cacheWidth === width) {
			return this.#cache;
		}
		const lines = this.#snapshot ? renderDashboard(this.#snapshot, width) : [];
		this.#cache = lines;
		this.#cacheWidth = width;
		return this.#cache;
	}
}
