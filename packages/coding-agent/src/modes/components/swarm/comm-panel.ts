/**
 * Communication Panel — renders CommBus message log.
 *
 * Shows recent messages between human and agents with colour-coded sender
 * types. Messages are displayed in chronological order (oldest first).
 */

import { makeFooter, makeHeader, padLine } from "./panel-utils";
import { sato } from "./theme";

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

/**
 * Render the comm log panel.
 *
 * Returns an array of chalk-coloured strings, one per display line.
 * Shows at most 20 messages; older ones are summarised.
 */
export function renderCommPanel(messages: CommMessage[] | null | undefined, maxWidth: number): string[] {
	const innerWidth = maxWidth - 4;
	if (innerWidth < 10) return [];

	const msgs = messages ?? [];
	const lines: string[] = [];

	lines.push(makeHeader("Comm", maxWidth));

	if (msgs.length === 0) {
		lines.push(padLine(` ${sato.dim("No messages")}`, maxWidth));
	} else {
		// Show last 20 messages
		const shown = msgs.length > 20 ? msgs.slice(-20) : msgs;
		for (const msg of shown) {
			lines.push(formatMessageLine(msg, innerWidth, maxWidth));
		}
		if (msgs.length > 20) {
			lines.push(padLine(` ${sato.dim(`... ${msgs.length - 20} older messages`)}`, maxWidth));
		}
	}

	lines.push(makeFooter(maxWidth, `${msgs.length} message${msgs.length === 1 ? "" : "s"}`));

	return lines;
}

// ============================================================================
// Internal
// ============================================================================

function senderColor(sender: string): (text: string) => string {
	if (sender === "human") return sato.amber;
	if (sender === "planner" || sender.startsWith("agent-") || sender.startsWith("worker-")) return sato.info;
	if (sender === "system") return sato.muted;
	return sato.text;
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	const s = String(d.getSeconds()).padStart(2, "0");
	return `${h}:${m}:${s}`;
}

function formatMessageLine(msg: CommMessage, innerWidth: number, maxWidth: number): string {
	const time = sato.dim(`[${formatTime(msg.timestamp)}]`);
	const from = senderColor(msg.from)(msg.from);
	const to = senderColor(msg.to)(msg.to);
	const arrow = sato.dim("→"); // →

	// Body: clip to fit
	const prefix = ` ${time} ${from} ${arrow} ${to}: `;
	const prefixLen = prefix.replace(/\x1b\[[0-9;]*m/g, "").length;
	const bodyBudget = innerWidth - prefixLen;

	let body: string;
	if (bodyBudget < 5) {
		body = sato.dim("…");
	} else {
		const raw = msg.body.replace(/\n/g, " ");
		body = raw.length > bodyBudget ? raw.slice(0, bodyBudget - 1) + "…" : raw; // …
	}

	return padLine(`${prefix}"${body}"`, maxWidth);
}
