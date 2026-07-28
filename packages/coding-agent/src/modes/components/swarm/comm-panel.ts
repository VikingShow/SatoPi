/**
 * Comm Panel — renders recent agent communication messages inside a system
 * `framedBlock`.  Uses the global `theme` for all colours.
 */

import type { Component } from "@oh-my-pi/pi-tui";
import type { Theme } from "../../theme/theme";
import { swarmPanel } from "./swarm-panel-block";

// ============================================================================
// Types
// ============================================================================

export interface CommMessage {
	timestamp: number;
	from: string;
	to: string;
	body: string;
}

// ============================================================================
// Public API
// ============================================================================

export function renderCommPanel(messages: CommMessage[], theme: Theme): Component {
	return swarmPanel("Comm", ({ innerWidth, theme }) => {
		if (messages.length === 0) {
			return [theme.fg("dim", "  No messages")];
		}

		const shown = messages.slice(0, 10);
		return shown.map(msg => formatMessageLine(msg, innerWidth, theme));
	}, theme);
}

// ============================================================================
// Internal
// ============================================================================

function senderColor(sender: string, theme: Theme): (text: string) => string {
	// Reviewer-like roles get amber/warning colour
	if (sender.toLowerCase().includes("reviewer")) {
		return (text: string) => theme.fg("warning", text);
	}
	return (text: string) => theme.fg("accent", text);
}

function formatTime(ts: number, theme: Theme): string {
	const date = new Date(ts);
	const h = date.getHours().toString().padStart(2, "0");
	const m = date.getMinutes().toString().padStart(2, "0");
	const s = date.getSeconds().toString().padStart(2, "0");
	return theme.fg("dim", `${h}:${m}:${s}`);
}

function formatMessageLine(msg: CommMessage, maxWidth: number, theme: Theme): string {
	const color = senderColor(msg.from, theme);
	const time = formatTime(msg.timestamp, theme);
	const from = color(msg.from);
	const to = msg.to !== "all" ? ` → ${theme.fg("muted", msg.to)}` : "";

	// Truncate body to fit
	const prefix = ` ${time} ${from}${to}: `;
	const prefixLen = prefix.replace(/\x1b\[[0-9;]*m/g, "").length;
	const bodyBudget = Math.max(5, maxWidth - prefixLen - 1);
	const body =
		msg.body.length > bodyBudget
			? `${msg.body.slice(0, bodyBudget - 2)}…`
			: msg.body;

	return `${prefix}${body}`;
}
