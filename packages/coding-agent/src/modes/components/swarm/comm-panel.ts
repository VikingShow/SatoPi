/**
 * Communication Panel — renders CommBus message log as ANSI-colored panel.
 *
 * Shows recent messages between human and agents with color-coded sender types.
 * Messages are displayed in reverse chronological order (newest first).
 */
import { ansiBold, ansiDim, ansiFg, SATOPI_COLORS } from "./theme";

// ============================================================================
// ANSI stripping (not exported by theme)
// ============================================================================

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function visibleLength(text: string): number {
	return stripAnsi(text).length;
}

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
// Box-drawing constants
// ============================================================================

const H = "─";
const TOP_LEFT = "┌";
const TOP_RIGHT = "┐";
const BOTTOM_LEFT = "└";
const BOTTOM_RIGHT = "┘";
const V = "│";

// ============================================================================
// Public API
// ============================================================================

/**
 * Render the communication message log panel.
 *
 * Returns an array of ANSI-colored strings, one per display line.
 * Every visible line is guaranteed to be at most `maxWidth` characters wide.
 *
 * Sender color coding:
 *  - "human" → amber (SATOPI_COLORS.primary)
 *  - "planner" → blue (SATOPI_COLORS.info)
 *  - "system" → dim (SATOPI_COLORS.muted)
 *  - agent-<id> / worker-<id> → blue (SATOPI_COLORS.info)
 *
 * Gracefully handles:
 *  - Empty message list (shows "No messages" placeholder)
 *  - Null/undefined messages (treated as empty)
 *  - Long message bodies (truncated with "...")
 */
export function renderCommPanel(messages: CommMessage[] | null | undefined, maxWidth: number): string[] {
	const msgs = messages ?? [];
	const innerWidth = maxWidth - 4; // "│ " + content + " │"
	if (innerWidth < 10) return [];

	const lines: string[] = [];

	// Header
	lines.push(_makeHeader("Communications", maxWidth));

	if (msgs.length === 0) {
		lines.push(_padLine(` ${ansiDim("No messages")}`, maxWidth));
	} else {
		// Show most recent messages first, up to a reasonable limit
		const maxDisplay = 50;
		const recent = msgs.slice(-maxDisplay).reverse();

		for (const msg of recent) {
			lines.push(_formatMessageLine(msg, innerWidth, maxWidth));
		}

		if (msgs.length > maxDisplay) {
			lines.push(_padLine(` ${ansiDim(`... and ${msgs.length - maxDisplay} older messages`)}`, maxWidth));
		}
	}

	// Footer with stats
	const statsLine = msgs.length > 0 ? `${msgs.length} message${msgs.length === 1 ? "" : "s"}` : "0 messages";
	lines.push(_makeFooter(maxWidth, statsLine));

	return lines;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Format a single message line.
 *
 *   [HH:MM:SS] FROM → TO: "BODY"
 *
 * Truncates long message bodies to fit within the available width.
 */
function _formatMessageLine(msg: CommMessage, innerWidth: number, maxWidth: number): string {
	const time = _formatTime(msg.timestamp);
	const fromColor = _senderColor(msg.from);

	// Build prefix: [HH:MM:SS] FROM → TO:
	const prefix = `[${time}] ${ansiFg(fromColor, msg.from)} → ${msg.to}: `;

	// Calculate available space for the body
	const prefixVisible = visibleLength(prefix);
	const quoteChars = 2; // opening and closing quotes
	const minBody = 3; // minimum to show "..."
	const available = innerWidth - 1 - prefixVisible - quoteChars; // -1 for leading space

	let body: string;
	const rawBody = msg.body.replace(/\n/g, " "); // flatten newlines
	if (available < minBody) {
		body = "";
	} else if (rawBody.length > available) {
		body = rawBody.slice(0, available - 3) + "...";
	} else {
		body = rawBody;
	}

	const line = ` ${prefix}"${body}"`;
	return _padLine(line, maxWidth);
}

/**
 * Determine the ANSI color code for a sender name.
 *
 *  - "human" → amber (primary)
 *  - "planner" → blue (info)
 *  - "system" → dim gray (muted)
 *  - agent-*, worker-* → blue (info)
 *  - everything else → muted
 */
function _senderColor(sender: string): number {
	if (sender === "human") return SATOPI_COLORS.primary.ansi256;
	if (sender === "planner") return SATOPI_COLORS.info.ansi256;
	if (sender === "system") return SATOPI_COLORS.muted.ansi256;
	if (sender.startsWith("agent-") || sender.startsWith("worker-")) return SATOPI_COLORS.info.ansi256;
	return SATOPI_COLORS.muted.ansi256;
}

/**
 * Format a Unix-epoch timestamp as HH:MM:SS.
 */
function _formatTime(ts: number): string {
	const d = new Date(ts);
	const h = String(d.getHours()).padStart(2, "0");
	const m = String(d.getMinutes()).padStart(2, "0");
	const s = String(d.getSeconds()).padStart(2, "0");
	return `${h}:${m}:${s}`;
}

/**
 * Build a top border line.
 */
function _makeHeader(title: string, width: number): string {
	const inner = `─ ${title} `;
	const remaining = width - TOP_LEFT.length - inner.length - TOP_RIGHT.length;
	const fill = remaining > 0 ? H.repeat(remaining) : "";
	return `${TOP_LEFT}${inner}${fill}${TOP_RIGHT}`;
}

/**
 * Build a bottom border line with optional stats text on the right side.
 */
function _makeFooter(width: number, stats: string): string {
	const fill = width - BOTTOM_LEFT.length - BOTTOM_RIGHT.length;
	if (fill <= 0) return `${BOTTOM_LEFT}${BOTTOM_RIGHT}`;

	const statsText = ` ${stats} `;
	if (visibleLength(statsText) >= fill) {
		return `${BOTTOM_LEFT}${H.repeat(fill)}${BOTTOM_RIGHT}`;
	}

	const hCount = fill - visibleLength(statsText);
	return `${BOTTOM_LEFT}${H.repeat(hCount)}${statsText}${BOTTOM_RIGHT}`;
}

/**
 * Pad a content line so its visible width fills to `width - 1`,
 * then close with the right border.
 */
function _padLine(content: string, width: number): string {
	const visible = visibleLength(content);
	const padding = Math.max(0, width - visible - 1); // -1 for right border V
	return content + " ".repeat(padding) + V;
}
