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
 *   Esc / q          → close overlay
 *   1-9, Enter        → select gate prompt option
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
	readonly #graphDefinition: GraphDefinitionLike | null;
	readonly #gateController: GateControllerLike | null;

	readonly #onSteering: ((message: string) => void) | null;

	/** Active human-review gate prompt, if any. */
	#gatePrompt: HumanReviewPrompt | null = null;

	constructor(deps: SwarmDashboardOverlayDeps) {
		this.#stateTracker = deps.stateTracker ?? null;
		this.#activityLogger = deps.activityLogger ?? null;
		this.#graphDefinition = deps.graphDefinition ?? null;
		this.#gateController = deps.gateController ?? null;
		this.#onSteering = deps.onSteering ?? null;

		this.#component = new SwarmDashboardComponent(this.#buildSnapshot());

		this.#binding = new SwarmTuiBinding({
			component: this.#component,
			snapshot: () => this.#buildSnapshot(),
			fsm: deps.fsm,
			requestRender: () => this.onRequestRender?.(),
		});

		// Listen for human-review gate prompts from GateController
		if (this.#gateController) {
			this.#gateController.on("human-review-request", (request: HumanReviewPrompt) => {
				this.#gatePrompt = request;
				this.onRequestRender?.();
			});
		}
	}

	// ── Component ────────────────────────────────────────────────────────

	render(width: number): readonly string[] {
		if (this.#gatePrompt) {
			return this.#renderGatePrompt(width);
		}
		return this.#component.render(width);
	}

	handleInput(data: string): void {
		// Gate prompt active — handle option selection
		if (this.#gatePrompt) {
			this.#handleGateInput(data);
			return;
		}
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

	// ── Gate prompt ──────────────────────────────────────────────────────

	#handleGateInput(data: string): void {
		const prompt = this.#gatePrompt!;
		const num = Number(data);

		if (data === "escape" || data === "q" || data === "\x1b") {
			// Dismiss — reject the gate
			this.#gateController?.rejectHumanGate(prompt.nodeLabel, "User dismissed");
			this.#gatePrompt = null;
			this.onRequestRender?.();
			return;
		}

		if (data === "\r" || data === "\n") {
			// Enter = confirm first option
			this.#resolveGate(prompt, { type: "continue" });
			return;
		}

		if (!isNaN(num) && num >= 1 && num <= prompt.options.length) {
			const choice = prompt.options[num - 1];
			if (choice === "Continue" || choice === "Approve" || choice === "Launch Stage") {
				this.#resolveGate(prompt, { type: "continue" });
			} else if (choice === "Block" || choice === "Cancel" || choice === "Reject") {
				this.#resolveGate(prompt, { type: "block", reason: choice });
			} else if (choice === "Retry" || choice === "Revise Plan") {
				this.#resolveGate(prompt, { type: "retry", delayMs: 0 });
			} else {
				this.#resolveGate(prompt, { type: "continue" });
			}
			return;
		}
	}

	#resolveGate(prompt: HumanReviewPrompt, action: GateActionLike): void {
		this.#gateController?.resolveHumanGate(prompt.nodeLabel, action);
		this.#gatePrompt = null;
		this.onRequestRender?.();
	}

	#renderGatePrompt(width: number): readonly string[] {
		const p = this.#gatePrompt!;
		const W = Math.max(40, width);
		const lines: string[] = [];
		const pad = " ".repeat(Math.max(0, Math.floor((W - 50) / 2)));

		lines.push("");
		lines.push(pad + sato.bold("╔══════════════════════════════════════════════════╗"));
		lines.push(pad + sato.bold("║") + sato.bold("  Human Review Required                           ") + sato.bold("║"));
		lines.push(pad + sato.bold("╠══════════════════════════════════════════════════╣"));
		lines.push(pad + sato.bold("║") + `  Node: ${sato.amber(p.nodeLabel.padEnd(42))}` + sato.bold("║"));
		lines.push(pad + sato.bold("║") + `  ${"".padEnd(48)}` + sato.bold("║"));

		// Prompt text — word wrap within 46 chars
		const promptWords = p.prompt.split(" ");
		let promptLine = "";
		for (const word of promptWords) {
			const candidate = promptLine ? `${promptLine} ${word}` : word;
			if (candidate.length > 46) {
				lines.push(pad + sato.bold("║") + `  ${promptLine.padEnd(46)}` + sato.bold("║"));
				promptLine = word;
			} else {
				promptLine = candidate;
			}
		}
		if (promptLine) {
			lines.push(pad + sato.bold("║") + `  ${promptLine.padEnd(46)}` + sato.bold("║"));
		}

		lines.push(pad + sato.bold("║") + `  ${"".padEnd(48)}` + sato.bold("║"));
		lines.push(pad + sato.bold("╠══════════════════════════════════════════════════╣"));

		// Options
		for (let i = 0; i < p.options.length; i++) {
			const num = `${i + 1}`;
			const opt = p.options[i];
			lines.push(pad + sato.bold("║") + `  [${sato.amber(num)}] ${opt.padEnd(43 - num.length)}` + sato.bold("║"));
		}

		lines.push(pad + sato.bold("╚══════════════════════════════════════════════════╝"));
		lines.push("");
		lines.push(pad + sato.dim("  Press 1-" + p.options.length + " to select, Esc to dismiss"));

		return lines;
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

		return { swarm, messages, context, graphView };
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

/** Human-review request payload from GateController. */
interface HumanReviewPrompt {
	nodeLabel: string;
	gateType: "human-review";
	prompt: string;
	options: string[];
	reviewId: string;
}

/** Gate action returned to resolve a human review. */
interface GateActionLike {
	type: "retry" | "block" | "continue";
	delayMs?: number;
	reason?: string;
}

/** Minimal shape of GateController needed for human-review events. */
interface GateControllerLike {
	on(event: "human-review-request", listener: (request: HumanReviewPrompt) => void): void;
	resolveHumanGate(nodeLabel: string, action: GateActionLike): void;
	rejectHumanGate(nodeLabel: string, reason: string): void;
}

export interface SwarmDashboardOverlayDeps {
	/** Workflow FSM (per-session). Subscribes to phase transitions. */
	fsm?: WorkflowFsm;
	/** StateTracker — source of SwarmState for the snapshot. */
	stateTracker?: StateTrackerLike;
	/** ActivityLogger — source of CommMessages for the snapshot. */
	activityLogger?: ActivityLoggerLike;
	/** Graph definition — used when mode is "graph" to render the DAG. */
	graphDefinition?: GraphDefinitionLike;
	/** GateController — for human-review gate prompts. */
	gateController?: GateControllerLike;
	/** Called when user presses "/" in the dashboard to send a steering message. */
	onSteering?: (message: string) => void;
}
