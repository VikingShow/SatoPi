/**
 * SwarmDashboardOverlay — pi-tui Component for the /swarm fullscreen overlay.
 *
 * Wraps SwarmDashboardComponent + SwarmTuiBinding so the overlay lifecycle
 * (open → render with live updates → Esc/q to close) is self-contained.
 *
 * Dependencies (stateTracker, activityLogger, fsm) are all optional — when
 * no swarm is active the overlay shows a placeholder panel and remains
 * responsive.  This decouples the overlay from any swarm-session lifecycle.
 *
 * Keyboard:
 *   Esc / q  → close overlay
 */

import type { Component } from "@oh-my-pi/pi-tui";
import type { SwarmState } from "../../../swarm/core/state";
import type { WorkflowFsm } from "../../../swarm/core/workflow-fsm";
import type { ActivityLogger } from "../../../swarm/infra/activity-logger";
import type { CommMessage } from "./comm-panel";
import type { ContextPanelState } from "./context-panel";
import { renderDashboard, type DashboardInput } from "./swarm-dashboard";
import { SwarmDashboardComponent } from "./swarm-dashboard-component";
import { SwarmTuiBinding } from "./swarm-tui-binding";
import { sato } from "./theme";

// ============================================================================
// SwarmDashboardOverlay
// ============================================================================

export class SwarmDashboardOverlay implements Component {
	/** Called by the host when the user dismisses the overlay. */
	onClose?: () => void;
	/** Called by the host after every snapshot update to trigger a repaint. */
	onRequestRender?: () => void;

	readonly #component: SwarmDashboardComponent;
	readonly #binding: SwarmTuiBinding;
	readonly #stateTracker: StateTrackerLike | null;
	readonly #activityLogger: ActivityLoggerLike | null;

	readonly #onSteering: ((message: string) => void) | null;

	constructor(deps: SwarmDashboardOverlayDeps) {
		this.#stateTracker = deps.stateTracker ?? null;
		this.#activityLogger = deps.activityLogger ?? null;
		this.#onSteering = deps.onSteering ?? null;

		this.#component = new SwarmDashboardComponent(this.#buildSnapshot());

		this.#binding = new SwarmTuiBinding({
			component: this.#component,
			snapshot: () => this.#buildSnapshot(),
			fsm: deps.fsm,
			requestRender: () => this.onRequestRender?.(),
		});
	}

	// ── Component ────────────────────────────────────────────────────────

	render(width: number): readonly string[] {
		return this.#component.render(width);
	}

	handleInput(data: string): void {
		// Handle keyboard dismissals — matching the PlanReviewOverlay idiom.
		if (data === "escape" || data === "q" || data === "\x1b") {
			this.onClose?.();
			return;
		}
		// "/" enters steering mode — capture next input as steering message
		if (data === "/" && this.#onSteering) {
			this.#onSteering(data);
			return;
		}
	}

	invalidate(): void {
		this.#component.invalidate();
	}

	// ── Lifecycle ────────────────────────────────────────────────────────

	/** Detach FSM listener. Idempotent. */
	dispose(): void {
		this.#binding.dispose();
	}

	// ── Snapshot builder ──────────────────────────────────────────────────

	#buildSnapshot(): DashboardInput {
		const tracker = this.#stateTracker;

		const swarm: SwarmState = tracker?.state ?? {
			name: "",
			status: "idle",
			mode: "loop",
			iteration: 0,
			targetCount: 0,
			agents: {},
			startedAt: 0 as unknown as number,
			phase: "idle",
		} as SwarmState;

		// CommMessages — reconstructed from ActivityLogger when a query API
		// is available.  For now the overlay shows agent + phase data only.
		const messages: CommMessage[] = this.#buildMessages();

		// ContextPanelState — metadata extracted from StateTracker.
		const context: ContextPanelState = {
			sources: [
				{ name: "Mnemopi", active: false },
				{ name: "Hindsight", active: false },
				{ name: "Experience", active: false },
			],
			l1PendingCount: 0,
			l2LastFlushSeconds: 0,
			l3Nodes: 0,
			l3Edges: 0,
			agents: Object.entries(swarm.agents ?? {}).map(([id]) => ({
				agentId: id,
				tokensUsed: 0,
				tokenBudget: 0,
			})),
		};

		return { swarm, messages, context };
	}

	#buildMessages(): CommMessage[] {
		// ActivityLogger does not expose a query API in the current
		// architecture — messages are written fire-and-forget to
		// session.jsonl.  Once a `getRecentMessages(n)` method is added
		// we can reconstruct CommMessage[] here.
		return [];
	}
}

// ============================================================================
// Types
// ============================================================================

/** Minimal shape of StateTracker needed by the snapshot builder. */
interface StateTrackerLike {
	readonly state: Readonly<SwarmState>;
}

/** Minimal shape of ActivityLogger (only the fields we reference). */
interface ActivityLoggerLike {
	// placeholder — no public query API yet
}

export interface SwarmDashboardOverlayDeps {
	/** Workflow FSM (per-session). Subscribes to phase transitions. */
	fsm?: WorkflowFsm;
	/** StateTracker — source of SwarmState for the snapshot. */
	stateTracker?: StateTrackerLike;
	/** ActivityLogger — source of CommMessages for the snapshot. */
	activityLogger?: ActivityLoggerLike;
	/** Called when user presses "/" in the dashboard to send a steering message. */
	onSteering?: (message: string) => void;
}
