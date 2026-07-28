/**
 * SwarmDashboardOverlay — pi-tui Component for the /swarm fullscreen overlay.
 *
 * Wraps SwarmDashboardComponent + SwarmTuiBinding so the overlay lifecycle
 * (open → render with live updates → Esc/q to close) is self-contained.
 *
 * Dependencies (stateTracker, fsm) are all optional — when
 * no swarm is active the overlay shows a placeholder panel and remains
 * responsive.  This decouples the overlay from any swarm-session lifecycle.
 *
 * Keyboard:
 *   Esc / q → close overlay
 *
 * Simplified: gate-prompt and steering-mode handling removed; those are
 * handled by dedicated controllers outside the overlay.
 */

import type { Component } from "@oh-my-pi/pi-tui";
import { type AgentRef, AgentRegistry } from "../../../registry/agent-registry";
import type { SwarmState } from "../../../swarm/core/state";
import type { WorkflowFsm } from "../../../swarm/core/workflow-fsm";
import type { CommMessage } from "./comm-panel";
import type { ContextPanelState } from "./context-panel";
import type { DashboardInput } from "./swarm-dashboard";
import { SwarmDashboardComponent } from "./swarm-dashboard-component";
import { SwarmTuiBinding } from "./swarm-tui-binding";

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
	readonly #graphDefinition: GraphDefinitionLike | null;

	constructor(deps: SwarmDashboardOverlayDeps) {
		this.#stateTracker = deps.stateTracker ?? null;
		this.#graphDefinition = deps.graphDefinition ?? null;

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
		if (data === "escape" || data === "q" || data === "\x1b") {
			this.onClose?.();
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

		const swarm: SwarmState =
			tracker?.state ??
			({
				name: "",
				status: "idle",
				mode: "loop",
				iteration: 0,
				targetCount: 0,
				agents: {},
				startedAt: 0 as unknown as number,
				phase: "idle",
			} as SwarmState);

		// Agents: primary source is AgentRegistry, swarm state enriches
		const agents: AgentRef[] = AgentRegistry.global().list();

		// CommMessages — placeholder until ActivityLogger exposes a query API
		const messages: CommMessage[] = [];

		// ContextPanelState — metadata extracted from StateTracker + AgentRegistry
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
			agents: agents.map(ref => ({
				agentId: ref.displayName,
				tokensUsed: 0,
				tokenBudget: 0,
			})),
		};

		// Graph view — built when mode is "graph" and graph definition is present
		let graphView: DashboardInput["graphView"];
		if (swarm.mode === "graph" && this.#graphDefinition) {
			const graphDef = this.#graphDefinition;
			const agentStates = swarm.agents ?? {};
			const nodes: Record<string, { label: string; status: string }> = {};

			for (const [id, node] of Object.entries(graphDef.nodes)) {
				const agentState = agentStates[id];
				nodes[id] = {
					label: node.label ?? id,
					status: agentState?.status ?? "pending",
				};
			}

			const edges = (graphDef.edges ?? []).map(e => ({
				from: e.from,
				to: e.to,
				artifacts: e.artifacts,
			}));

			graphView = {
				graph: { nodes, edges },
				width: 80,
			};
		}

		return { agents, swarm, messages, context, graphView };
	}
}

// ============================================================================
// Types
// ============================================================================

/** Minimal shape of StateTracker needed by the snapshot builder. */
interface StateTrackerLike {
	readonly state: Readonly<SwarmState>;
}

/** Minimal shape of a graph node from GraphDefinition. */
interface GraphNodeLike {
	label: string;
}

/** Minimal shape of a graph edge from GraphDefinition. */
interface GraphEdgeLike {
	from: string;
	to: string;
	artifacts?: string[];
}

/** Minimal shape of GraphDefinition needed by the snapshot builder. */
interface GraphDefinitionLike {
	nodes: Record<string, GraphNodeLike>;
	edges?: GraphEdgeLike[];
}

export interface SwarmDashboardOverlayDeps {
	/** Workflow FSM (per-session). Subscribes to phase transitions. */
	fsm?: WorkflowFsm;
	/** StateTracker — source of SwarmState for the snapshot. */
	stateTracker?: StateTrackerLike;
	/** Graph definition — used when mode is "graph" to render the DAG. */
	graphDefinition?: GraphDefinitionLike;
}
