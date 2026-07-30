import type { Component } from "@satopi/pi-tui";
import { AgentRegistry } from "../../../registry/agent-registry";
import { formatStatusIcon } from "../../../tools/render-utils";
import type { Theme } from "../../theme/theme";
import { swarmPanel } from "./swarm-panel-block";

type ToolUIStatus = "done" | "error" | "aborted" | "running" | "pending";

const ICON: Record<string, ToolUIStatus> = {
	completed: "done", failed: "error", aborted: "aborted",
	running: "running", idle: "done", parked: "done", pending: "pending",
};

export interface SwarmSidebarConfig {
	onSelectAgent?: (agentId: string) => void;
	onClose?: () => void;
	onRequestRender?: () => void;
}

export class SwarmSidebar implements Component {
	readonly #config: SwarmSidebarConfig;
	readonly #theme: Theme;
	#selectedIndex = 0;
	#unsubscribe?: () => void;

	constructor(config: SwarmSidebarConfig, theme: Theme) {
		this.#config = config;
		this.#theme = theme;
		this.#unsubscribe = AgentRegistry.global().onChange(() => {
			this.#config.onRequestRender?.();
		});
	}

	render(width: number): readonly string[] {
		// Use swarmPanel to match existing agent-panel styling
		const panel = swarmPanel("Agents", ({ innerWidth, theme }) => {
			const refs = AgentRegistry.global().list().filter(r => r.kind !== "advisor");
			if (refs.length === 0) return [theme.fg("dim", "  No active agents")];
			const lines: string[] = [];
			const max = Math.min(refs.length, 8);
			for (let i = 0; i < max; i++) {
				const ref = refs[i];
				const selected = i === this.#selectedIndex;
				const iconStatus = ICON[ref.status] ?? "done";
				const glyph = formatStatusIcon(iconStatus, theme);
				const cursor = selected ? theme.fg("accent", "*") : " ";
				const maxName = Math.max(4, innerWidth - 14);
				const name = ref.displayName.length > maxName
					? ref.displayName.slice(0, maxName - 1) + "\u2026"
					: ref.displayName;
				const role = ref.role ? theme.fg("dim", ` ${ref.role.slice(0, 8)}`) : "";
				const color: string = ref.status === "running" ? "accent"
					: ref.status === "failed" ? "error" : "dim";
				lines.push(`${cursor}${theme.fg(color as "accent" | "error" | "dim", glyph)} ${name.padEnd(maxName)}${role}`);
			}
			if (refs.length > max) lines.push(theme.fg("dim", `  +${refs.length - max} more`));
			lines.push("");
			lines.push(theme.fg("dim", ` j/k nav  Enter sel  Esc close`));
			return lines;
		}, this.#theme);
		return panel.render(width);
	}

	handleInput(data: string): void {
		const refs = AgentRegistry.global().list().filter(r => r.kind !== "advisor");
		const max = Math.min(refs.length, 8);
		switch (data) {
			case "j": case "ArrowDown":
				if (max > 0) { this.#selectedIndex = Math.min(max - 1, this.#selectedIndex + 1); this.#config.onRequestRender?.(); }
				break;
			case "k": case "ArrowUp":
				this.#selectedIndex = Math.max(0, this.#selectedIndex - 1); this.#config.onRequestRender?.();
				break;
			case "Enter":
				if (refs[this.#selectedIndex]) { this.#config.onSelectAgent?.(refs[this.#selectedIndex].id); this.#config.onClose?.(); }
				break;
			case "escape": case "q": case "\x1b":
				this.#config.onClose?.();
				break;
		}
	}

	dispose(): void { this.#unsubscribe?.(); }
}
