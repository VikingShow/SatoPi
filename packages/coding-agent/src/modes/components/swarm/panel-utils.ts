/**
 * Shared TUI panel helpers for swarm dashboard panels.
 *
 * Uses pi-tui utilities (visibleWidth, truncateToWidth, padding) and
 * SatoPi box-drawing chars for consistent rendering across all panels.
 */

import chalk from "chalk";
import { padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

// ============================================================================
// Box-drawing symbols
// ============================================================================

/** SatoPi box-drawing set — sharp corners (matches satopi.json theme). */
const BOX = {
	horizontal: "─",
	vertical: "│",
	topLeft: "┌",
	topRight: "┐",
	bottomLeft: "└",
	bottomRight: "┘",
};

// ============================================================================
// Build helpers
// ============================================================================

/**
 * Build a top border line with embedded title.
 *
 *   ┌─ Title ────────────────────────────┐
 */
export function makeHeader(title: string, width: number): string {
	const inner = `${BOX.horizontal} ${title} `;
	const fillWidth = width - BOX.topLeft.length - inner.length - BOX.topRight.length;
	const fill = fillWidth > 0 ? BOX.horizontal.repeat(fillWidth) : "";
	return `${BOX.topLeft}${inner}${fill}${BOX.topRight}`;
}

/**
 * Build a bottom border line, optionally with right-aligned stats.
 *
 *   └─ 5 messages ───────────────────────┘
 */
export function makeFooter(width: number, stats?: string): string {
	if (stats) {
		const inner = `${BOX.horizontal} ${stats} `;
		const fillWidth = width - BOX.bottomLeft.length - inner.length - BOX.bottomRight.length;
		const fill = fillWidth > 0 ? BOX.horizontal.repeat(fillWidth) : "";
		return `${BOX.bottomLeft}${inner}${fill}${BOX.bottomRight}`;
	}
	const fillWidth = width - BOX.bottomLeft.length - BOX.bottomRight.length;
	return `${BOX.bottomLeft}${BOX.horizontal.repeat(Math.max(0, fillWidth))}${BOX.bottomRight}`;
}

/**
 * Pad a content line to fill `width`, ending with the vertical border.
 *
 * If content exceeds the available space (width - 1 for the right border),
 * it is safely truncated via pi-tui's truncateToWidth with "…" appended.
 */
export function padLine(content: string, width: number): string {
	const maxContent = width - 1; // reserve 1 column for right border
	const contentWidth = visibleWidth(content);

	if (contentWidth <= maxContent) {
		return content + padding(maxContent - contentWidth) + BOX.vertical;
	}

	// Truncate preserving ANSI codes (pi-tui truncateToWidth handles this)
	const truncated = truncateToWidth(content, Math.max(1, maxContent - 1));
	return truncated + "…" + BOX.vertical;
}
