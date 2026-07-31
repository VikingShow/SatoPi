/**
 * CrewEntryBlock — collapsible framed block for one agent's turn in a crew chat.
 *
 * Renders an agent's message with status icon, credit badge, timestamp,
 * body preview (collapsed) or full body + tool call sub-blocks (expanded).
 *
 * Keyboard:
 *   Enter — toggle collapsed/expanded
 *   Ctrl+O — global expand/collapse via setExpanded()
 */

import type { Component } from "@satopi/pi-tui";
import type { Theme } from "../../theme/theme";
import { swarmPanel } from "./swarm-panel-block";
import {
	formatBadge,
	formatExpandHint,
	formatStatusIcon,
	truncateToWidth,
	wrapTextWithAnsi,
	type ToolUIStatus,
} from "../../../tools/render-utils";
import { agentColor, formatTime } from "./crew-transcript-view";

// ============================================================================
// Public types
// ============================================================================

export interface CrewEntryBlockInput {
	agentId: string;
	displayName: string;
	body: string;
	timestamp: number;
	toolCalls?: Array<{ name: string; summary: string }>;
	creditScore?: number;
	status?: "completed" | "running" | "failed" | "pending";
}

// ============================================================================
// CrewEntryBlock
// ============================================================================

export class CrewEntryBlock implements Component {
	readonly #input: CrewEntryBlockInput;
	readonly #theme: Theme;
	#collapsed = true;

	constructor(input: CrewEntryBlockInput, theme: Theme) {
		this.#input = input;
		this.#theme = theme;
	}

	/** Global expand/collapse toggle (e.g. Ctrl+O). */
	setExpanded(expanded: boolean): void {
		this.#collapsed = !expanded;
	}

	render(width: number): readonly string[] {
		const panel = swarmPanel(
			this.#input.displayName,
			({ innerWidth, theme: t }) => {
				const lines: string[] = [];

				// --- Header line ---
				const uiStatus: ToolUIStatus = mapStatus(this.#input.status);
				const statusIcon = formatStatusIcon(uiStatus, t);
				const coloredName = agentColor(this.#input.agentId, t)(this.#input.displayName);
				const time = formatTime(this.#input.timestamp, t);

				const headerParts = [statusIcon, coloredName];
				if (this.#input.creditScore !== undefined) {
					headerParts.push(formatBadge(`credit:${this.#input.creditScore}`, "muted", t));
				}
				headerParts.push(time);
				lines.push(headerParts.join(" "));

				if (this.#collapsed) {
					// --- Collapsed: 2-line preview + tool call count + expand hint ---
					lines.push("");

					const bodyLines = this.#input.body.split("\n");
					const previewLines = Math.min(2, bodyLines.length);
					for (let i = 0; i < previewLines; i++) {
						lines.push(truncateToWidth(bodyLines[i], innerWidth));
					}

					if (this.#input.toolCalls && this.#input.toolCalls.length > 0) {
						const names = this.#input.toolCalls.map(tc => `${tc.name}()`).join(", ");
						lines.push(t.fg("dim", `[${this.#input.toolCalls.length} tool calls: ${names}]`));
					}

					const hint = formatExpandHint(t, false, true);
					if (hint) lines.push(hint);
				} else {
					// --- Expanded: full body + tool call sub-blocks ---
					lines.push("");

					const wrapped = wrapTextWithAnsi(this.#input.body, innerWidth);
					for (const wline of wrapped) {
						lines.push(wline);
					}

					if (this.#input.toolCalls && this.#input.toolCalls.length > 0) {
						lines.push("");
						for (const tc of this.#input.toolCalls) {
							lines.push(t.fg("dim", `  \u2514 ${tc.name}()`));
							lines.push(t.fg("dim", `    ${tc.summary}`));
						}
					}
				}

				return lines;
			},
			this.#theme,
		);
		return panel.render(width);
	}

	handleInput(data: string): void {
		if (data === "\r") {
			this.#collapsed = !this.#collapsed;
		}
	}

	invalidate(): void {
		// Stateless render — no memo to clear.
	}

	dispose(): void {
		// No resources to release.
	}
}

// ============================================================================
// Helpers
// ============================================================================

function mapStatus(status: CrewEntryBlockInput["status"]): ToolUIStatus {
	switch (status) {
		case "completed":
			return "success";
		case "running":
			return "running";
		case "failed":
			return "error";
		case "pending":
			return "pending";
		default:
			return "pending";
	}
}
