/**
 * Swarm splash screen — renders the SatoPi logo using the system PI_LOGO
 * from welcome.ts, with theme-consistent border colours.
 */

import { padding } from "@oh-my-pi/pi-tui";
import type { Theme } from "../../theme/theme";
import { PI_LOGO } from "../welcome";

const LOGO_WIDTH = 41;
const MIN_WIDTH = 60;

export function renderSplash(width: number = 80, theme: Theme): string[] {
	const w = Math.max(width, MIN_WIDTH);
	const innerW = w - 2;
	const border = (text: string) => theme.fg("warning", text);
	const lines: string[] = [];

	// Top border
	lines.push(border(`${theme.boxRound.topLeft}${"═".repeat(innerW)}${theme.boxRound.topRight}`));

	// Empty line
	lines.push(border(`${theme.boxRound.vertical}${padding(innerW)}${theme.boxRound.vertical}`));

	// "SatoPi" centered
	const nameStr = "S a t o P i";
	const nameLen = 8;
	const namePad = Math.floor((innerW - nameLen) / 2);
	const nameLine =
		padding(Math.max(0, namePad)) +
		theme.bold(theme.fg("accent", nameStr)) +
		padding(Math.max(0, innerW - namePad - nameLen));
	lines.push(border(theme.boxRound.vertical) + nameLine + border(theme.boxRound.vertical));

	// Spacing
	lines.push(border(`${theme.boxRound.vertical}${padding(innerW)}${theme.boxRound.vertical}`));

	// Pi logo — centered
	const logoPadLeft = Math.floor((innerW - LOGO_WIDTH) / 2);
	for (const logoLine of PI_LOGO) {
		const trimmed = logoLine.length > LOGO_WIDTH ? logoLine.substring(0, LOGO_WIDTH) : logoLine.padEnd(LOGO_WIDTH);
		const padRight = innerW - logoPadLeft - LOGO_WIDTH;
		lines.push(
			border(theme.boxRound.vertical) +
				padding(Math.max(0, logoPadLeft)) +
				theme.fg("dim", trimmed) +
				padding(Math.max(0, padRight)) +
				border(theme.boxRound.vertical),
		);
	}

	// Spacing
	lines.push(border(`${theme.boxRound.vertical}${padding(innerW)}${theme.boxRound.vertical}`));

	// Bottom border
	lines.push(border(`${theme.boxRound.bottomLeft}${"═".repeat(innerW)}${theme.boxRound.bottomRight}`));

	// Tagline
	const tagline = "Satori a team of Pi";
	const taglinePad = Math.max(0, Math.floor((w - tagline.length) / 2));
	lines.push(padding(taglinePad) + theme.fg("dim", tagline));

	return lines;
}
