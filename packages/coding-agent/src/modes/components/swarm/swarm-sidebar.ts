/**
 * SwarmSidebar — TUI sidebar showing agent/crew tree with status.
 *
 * Renders a scrollable list of agents from AgentRegistry with status
 * indicators, role labels, and crew membership. Supports keyboard
 * navigation (j/k, Enter to select).
 *
 * ## Layout
 *   ┌─ Agents ────────────────────┐
 *   │ ● architect    idle  planner│
 *   │ ● worker-1     run   coder  │
 *   │ ○ reflector    wait  analyst│
 *   │ 👥 design-crew  (2 members) │
 *   └─────────────────────────────┘
 */

import type { Component } from "@satopi/pi-tui";
import { AgentRegistry } from "../../registry/agent-registry";
import type { Theme } from "../theme/theme";

// ============================================================================
// Types
// ============================================================================

export interface SidebarAgentEntry {
	id: string;
	displayName: string;
	kind: string;
	status: string;
	role?: string;
	profileId?: string;
	selected: boolean;
}

export interface SidebarCrewEntry {
	id: string;
	name: string;
	memberCount: number;
}

export type SidebarEntry =
	| { type: "agent"; agent: SidebarAgentEntry }
	| { type: "crew"; crew: SidebarCrewEntry }
	| { type: "separator" };

export interface SwarmSidebarConfig {
	/** Callback when user selects an agent (Enter). */
	onSelectAgent?: (agentId: string) => void;
	/** Callback when user selects a crew. */
	onSelectCrew?: (crewId: string) => void;
	/** Max visible entries before scrolling (default 15). */
	maxVisible?: number;
}

// ============================================================================
// Status display helpers
// ============================================================================

const STATUS_GLYPH: Record<string, string> = {
	running: "●",
	idle: "○",
	parked: "○",
	pending: "○",
	completed: "✓",
	failed: "✗",
	aborted: "⚠",
};

const STATUS_COLOR: Record<string, string> = {
	running: "accent",
	idle: "dim",
	parked: "dim",
	pending: "dim",
	completed: "success",
	failed: "error",
	aborted: "warning",
};

// ============================================================================
// SwarmSidebar
// ============================================================================

export class SwarmSidebar implements Component {
	readonly rows: number;
	readonly cols: number;
	readonly name = "SwarmSidebar";

	readonly #config: SwarmSidebarConfig;
	readonly #theme: Theme;
	#entries: SidebarEntry[] = [];
	#selectedIndex = 0;

	constructor(config: SwarmSidebarConfig, theme: Theme) {
		this.#config = config;
		this.#theme = theme;
		this.rows = config.maxVisible ?? 15;
		this.cols = 35; // Fixed width for sidebar
	}

	// ==========================================================================
	// Layout
	// ==========================================================================

	layout(_maxRows: number, _maxCols: number): void {
		this.refresh();
	}

	/**
	 * Refresh entries from AgentRegistry.
	 * Call this when agents are spawned/completed.
	 */
	refresh(): void {
		const refs = AgentRegistry.global().list();
		this.#entries = [];

		// Header
		this.#entries.push({ type: "separator" });

		for (const ref of refs) {
			// Skip the main agent itself when swarm is active
			if (ref.kind === "advisor") continue;

			this.#entries.push({
				type: "agent",
				agent: {
					id: ref.id,
					displayName: ref.displayName,
					kind: ref.kind,
					status: ref.status,
					role: ref.role,
					profileId: ref.profileId,
					selected: this.#entries.length - 1 === this.#selectedIndex,
				},
			});
		}
	}

	// ==========================================================================
	// Keyboard
	// ==========================================================================

	handleKey(key: string): boolean {
		switch (key) {
			case "j":
			case "ArrowDown":
				this.#moveSelection(1);
				return true;
			case "k":
			case "ArrowUp":
				this.#moveSelection(-1);
				return true;
			case "Enter":
				this.#selectCurrent();
				return true;
			default:
				return false;
		}
	}

	#moveSelection(delta: number): void {
		const agentEntries = this.#entries.filter(e => e.type === "agent");
		if (agentEntries.length === 0) return;
		this.#selectedIndex = Math.max(0, Math.min(agentEntries.length - 1, this.#selectedIndex + delta));
		this.refresh();
	}

	#selectCurrent(): void {
		const agentEntries = this.#entries.filter(e => e.type === "agent");
		const entry = agentEntries[this.#selectedIndex];
		if (entry && entry.type === "agent") {
			this.#config.onSelectAgent?.(entry.agent.id);
		}
	}

	// ==========================================================================
	// Render
	// ==========================================================================

	render(): string[] {
		const lines: string[] = [];
		const theme = this.#theme;
		const maxWidth = this.cols - 2; // Borders

		// Header
		lines.push(theme.fg("accent", `┌─ Agents ─${"─".repeat(maxWidth - 10)}┐`));

		// Limit to visible entries
		const visible = this.#entries.slice(0, this.rows - 2);

		for (const entry of visible) {
			if (entry.type === "separator") {
				lines.push(theme.fg("dim", `│${" ".repeat(maxWidth)}│`));
				continue;
			}

			if (entry.type === "agent") {
				const a = entry.agent;
				const glyph = STATUS_GLYPH[a.status] ?? " ";
				const color = STATUS_COLOR[a.status] ?? "dim";
				const selected = a.selected ? theme.fg("accent", "›") : " ";
				const name = a.selected ? theme.bold(a.displayName.slice(0, 20)) : a.displayName.slice(0, 20);
				const role = a.role ? theme.fg("dim", a.role.slice(0, 10)) : "";
				const status = a.status === "running" ? theme.fg(color, glyph) : theme.fg(color, glyph);

				const line = `│${selected} ${status} ${name.padEnd(20)} ${role.padEnd(10)}│`;
				lines.push(line.slice(0, maxWidth + 2));
			}

			if (entry.type === "crew") {
				const c = entry.crew;
				const line = `│  👥 ${c.name.slice(0, 15).padEnd(15)} (${c.memberCount})${" ".repeat(maxWidth - 25)}│`;
				lines.push(line.slice(0, maxWidth + 2));
			}
		}

		// Footer
		lines.push(theme.fg("dim", `└${"─".repeat(maxWidth)}┘`));
		lines.push(theme.fg("dim", " j/k navigate · Enter select"));

		return lines;
	}
}
