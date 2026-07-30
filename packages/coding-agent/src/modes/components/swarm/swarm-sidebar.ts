/**
 * SwarmSidebar — TUI agent/crew list panel matching existing swarm style.
 *
 * Uses `swarmPanel` wrapper for consistent border/chrome. Shows agent status
 * with icons, role badges, and profile scores. Keyboard: j/k to navigate,
 * Enter to select, Ctrl+B to toggle visibility.
 *
 * Integrates with the existing subagentContainer area — renders agent list
 * from AgentRegistry with live status updates.
 */

import type { Component } from "@satopi/pi-tui";
import { type AgentRef, AgentRegistry } from "../../../registry/agent-registry";
import { formatStatusIcon } from "../../../tools/render-utils";
import type { Theme } from "../../theme/theme";
import { swarmPanel } from "./swarm-panel-block";

// ============================================================================
// Config
// ============================================================================

export interface SwarmSidebarConfig {
	/** Callback when user selects an agent (Enter). */
	onSelectAgent?: (agentId: string) => void;
	/** Callback when user requests render (for live updates). */
	onRequestRender?: () => void;
}

// ============================================================================
// Status mapping (matches agent-panel.ts)
// ============================================================================

const STATUS_ICON: Record<string, string> = {
	completed: "done",
	failed: "error",
	aborted: "aborted",
	running: "running",
	idle: "done",
	parked: "done",
	pending: "pending",
};

// ============================================================================
// SwarmSidebar
// ============================================================================

export class SwarmSidebar implements Component {
	onRequestRender?: () => void;

	readonly #config: SwarmSidebarConfig;
	readonly #theme: Theme;
	#selectedIndex = 0;
	#visible = true;

	constructor(config: SwarmSidebarConfig, theme: Theme) {
		this.#config = config;
		this.#theme = theme;
	}

	get visible(): boolean {
		return this.#visible;
	}

	toggle(): void {
		this.#visible = !this.#visible;
		this.onRequestRender?.();
	}

	handleKey(key: string): boolean {
		if (!this.#visible) return false;

		const refs = this.#getVisibleRefs();
		switch (key) {
			case "j":
			case "ArrowDown":
				if (refs.length > 0) {
					this.#selectedIndex = Math.min(refs.length - 1, this.#selectedIndex + 1);
					this.onRequestRender?.();
				}
				return true;
			case "k":
			case "ArrowUp":
				this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
				this.onRequestRender?.();
				return true;
			case "Enter":
				if (refs[this.#selectedIndex]) {
					this.#config.onSelectAgent?.(refs[this.#selectedIndex].id);
				}
				return true;
			default:
				return false;
		}
	}

	render(): string[] {
		if (!this.#visible) return [];

		return swarmPanel("Agents", ({ innerWidth, theme }) => {
			const refs = this.#getVisibleRefs();
			if (refs.length === 0) {
				return [theme.fg("dim", "  No agents")];
			}

			const lines: string[] = [];

			// Show max 8 agents (fit in terminal)
			const maxVisible = Math.min(refs.length, 8);
			for (let i = 0; i < maxVisible; i++) {
				const ref = refs[i];
				const isSelected = i === this.#selectedIndex;
				const line = this.#formatAgentLine(ref, isSelected, innerWidth, theme);
				lines.push(line);
			}

			if (refs.length > maxVisible) {
				lines.push(theme.fg("dim", `  ... and ${refs.length - maxVisible} more`));
			}

			// Footer
			lines.push("");
			lines.push(theme.fg("dim", ` ${theme.format.bracketLeft}j/k${theme.format.bracketRight} navigate  ${theme.format.bracketLeft}Enter${theme.format.bracketRight} select  ${theme.format.bracketLeft}Ctrl+B${theme.format.bracketRight} toggle`));

			return lines;
		}, theme);
	}

	// ==========================================================================
	// Internal
	// ==========================================================================

	#getVisibleRefs(): AgentRef[] {
		return AgentRegistry.global()
			.list()
			.filter(ref => ref.kind !== "advisor");
	}

	#formatAgentLine(ref: AgentRef, selected: boolean, width: number, theme: Theme): string {
		const status = ref.status;
		const iconStatus = STATUS_ICON[status] ?? "done";
		const glyph = formatStatusIcon(iconStatus, theme);
		const cursor = selected ? theme.fg("accent", "›") : " ";

		// Name (truncated)
		const maxName = Math.max(5, width - 22);
		const name = ref.displayName.length > maxName
			? ref.displayName.slice(0, maxName - 1) + "…"
			: ref.displayName.padEnd(maxName);

		// Kind badge
		const kindBadge = ref.kind === "sub"
			? theme.fg("dim", `${theme.format.bracketLeft}sub${theme.format.bracketRight}`)
			: ref.profileId
				? theme.fg("accent", `${theme.format.bracketLeft}P${theme.format.bracketRight}`)
				: "";

		// Role
		const role = ref.role ? theme.fg("dim", ref.role.slice(0, 8)) : "";

		// Status icon
		const statusColor = status === "running" ? "accent" : status === "failed" ? "error" : "dim";

		const line = `${cursor} ${theme.fg(statusColor, glyph)} ${theme.fg(selected ? "accent" : "default", name)} ${kindBadge} ${role}`;

		return line;
	}
}
