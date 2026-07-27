/**
 * SwarmTuiBinding — declarative wiring between swarm state and the dashboard.
 *
 * Replaces ad-hoc polling with event-driven updates: it subscribes to the one
 * change source that exposes an observable API today — `WorkflowFsm.onChange`
 * (phase transitions) — and rebuilds the dashboard snapshot whenever it fires.
 *
 * `StateTracker` and `CommBus` do NOT expose subscription APIs yet, so agent /
 * message updates are delivered through the explicit `notify()` push seam:
 * whoever mutates those (the swarm event loop / ActivityLogger) calls `notify()`
 * to refresh the view. When those gain observable APIs, subscribe here and the
 * consumers stop needing to push.
 */

import type { WorkflowFsm } from "../../../swarm/core/workflow-fsm";
import type { DashboardInput } from "./swarm-dashboard";
import type { SwarmDashboardComponent } from "./swarm-dashboard-component";

export interface SwarmTuiBindingOpts {
	/** The component to drive. */
	component: SwarmDashboardComponent;
	/** Pulls the current swarm state into a fresh dashboard snapshot. */
	snapshot: () => DashboardInput;
	/** Real change source — phase transitions. Optional so the binding is testable standalone. */
	fsm?: WorkflowFsm;
	/** Asks the host TUI to repaint after an update (e.g. `ui.requestRender`). */
	requestRender?: () => void;
}

export class SwarmTuiBinding {
	readonly #opts: SwarmTuiBindingOpts;
	#unsubscribe?: () => void;

	constructor(opts: SwarmTuiBindingOpts) {
		this.#opts = opts;
		// Subscribe to the only observable source. onChange returns an unsubscribe fn.
		this.#unsubscribe = opts.fsm?.onChange(() => this.notify());
	}

	/** Rebuild the snapshot from current state and push it to the component. */
	notify(): void {
		this.#opts.component.update(this.#opts.snapshot());
		this.#opts.requestRender?.();
	}

	/** Detach the fsm listener. Idempotent. */
	dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}
}
