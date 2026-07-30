/**
 * SwarmDashboardOverlay — pi-tui Component for the /swarm fullscreen overlay.
 *
 * Builds a DashboardInput snapshot from swarm state, passes it to
 * `renderDashboard`, and renders the resulting Component tree.
 * Keyboard: Esc / q → close overlay.
 */

import type { Component } from "@satopi/pi-tui";
import { type AgentRef, AgentRegistry } from "../../../registry/agent-registry";
import type { SwarmState } from "../../../swarm/core/state";
import { theme as appTheme, type Theme } from "../../theme/theme";
import type { CommMessage } from "./comm-panel";
import type { ContextPanelState } from "./context-panel";
import type { ModelCostInfo } from "./cost-panel";
import { startPhasePulse, stopPhasePulse } from "./phase-view";
import type { RoundtableViewState } from "./roundtable-view";
import type { DashboardInput } from "./swarm-dashboard";
import { renderDashboard } from "./swarm-dashboard";
import type { TaskPanelInput } from "./task-panel";

// ============================================================================
// SwarmDashboardOverlay
// ============================================================================

export class SwarmDashboardOverlay implements Component {
	onClose?: () => void;
	onRequestRender?: () => void;

	readonly #stateTracker: StateTrackerLike | null;
	readonly #graphDefinition: GraphDefinitionLike | null;
	readonly #theme: Theme;
	readonly #modelCost: ModelCostInfo | undefined;
	readonly #roundtableState: RoundtableViewState | undefined;
	readonly #planContent: string | undefined;

	constructor(deps: SwarmDashboardOverlayDeps) {
		this.#stateTracker = deps.stateTracker ?? null;
		this.#graphDefinition = deps.graphDefinition ?? null;
		this.#theme = deps.theme ?? appTheme;
		this.#roundtableState = deps.roundtableState;
		this.#planContent = deps.planContent;
		this.#modelCost = deps.modelCost;

		// Start pulse animation for the current-phase highlight.
		startPhasePulse(() => this.onRequestRender?.());
	}

	render(width: number): readonly string[] {
		const input = this.#buildSnapshot();
		const dashboard = renderDashboard(input);
		return dashboard.render(width);
	}

	handleInput(data: string): void {
		if (data === "escape" || data === "q" || data === "\x1b") {
			this.onClose?.();
		}
	}

	invalidate(): void {}
	dispose(): void {
		stopPhasePulse();
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

		const agents: AgentRef[] = AgentRegistry.global().list();

		const messages: CommMessage[] = [];

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

		// Build task panel data from todos + graph edges
		let taskPanel: TaskPanelInput | undefined;
		const todos = swarm.todos;
		if (todos && todos.length > 0) {
			taskPanel = {
				todos,
				agents: swarm.agents,
				dagEdges: this.#graphDefinition?.edges,
				startedAt: typeof swarm.startedAt === "number" ? swarm.startedAt : undefined,
			};
		}

		return {
			agents,
			swarm,
			messages,
			context,
			graphView,
			taskPanel,
			theme: this.#theme,
			modelCost: this.#modelCost,
			planContent: this.#planContent,
			roundtable: this.#roundtableState,
		};
	}
}

// ============================================================================
// Types
// ============================================================================

interface StateTrackerLike {
	readonly state: Readonly<SwarmState>;
}

interface GraphNodeLike {
	label: string;
}

interface GraphEdgeLike {
	from: string;
	to: string;
	artifacts?: string[];
}

interface GraphDefinitionLike {
	nodes: Record<string, GraphNodeLike>;
	edges?: GraphEdgeLike[];
}

export interface SwarmDashboardOverlayDeps {
	stateTracker?: StateTrackerLike;
	graphDefinition?: GraphDefinitionLike;
	theme?: Theme;
	modelCost?: ModelCostInfo;
	/** Raw plan.md content for the plan structure panel. */
	planContent?: string;
	/** Roundtable debate state for the structured debate panel. */
	roundtableState?: RoundtableViewState;
}
