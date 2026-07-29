/**
 * SwarmPanelBlock — wraps a content generator in the system's `framedBlock`.
 *
 * Replaces `panel-utils.ts` (makeHeader/makeFooter/padLine) with the shared
 * `framedBlock` + `renderStatusLine` primitives. Panels that previously returned
 * `string[]` now return a pi-tui `Component`, which benefits from differential
 * rendering and diff caching.
 */

import type { Component } from "@satopi/pi-tui";
import { framedBlock, type OutputBlockOptions } from "../../../tui/output-block";
import type { Theme } from "../../theme/theme";

export interface SwarmPanelContentOpts {
	/** Available width for content (inside borders, after padding). */
	innerWidth: number;
	/** Active TUI theme for colour and symbol lookups. */
	theme: Theme;
}

/**
 * Wrap a content generator in a bordered frame using the system's output-block
 * primitives. The frame uses `borderMuted` colour (consistent with other muted
 * tool frames) and the system's rounded box corners.
 */
export function swarmPanel(
	title: string,
	contentFn: (opts: SwarmPanelContentOpts) => readonly string[],
	theme: Theme,
	options?: { headerMeta?: string; applyBg?: boolean },
): Component {
	// Reserve 4 columns for border + padding ("│ " + content + " │")
	const PADDING_TOTAL = 4;

	return framedBlock(theme, width => {
		const innerWidth = Math.max(1, width - PADDING_TOTAL);
		const lines = contentFn({ innerWidth, theme });

		const opts: OutputBlockOptions = {
			header: title,
			headerMeta: options?.headerMeta,
			sections: lines.length > 0 ? [{ lines }] : undefined,
			width,
			applyBg: options?.applyBg ?? false,
			borderColor: "borderMuted",
		};
		return opts;
	});
}
