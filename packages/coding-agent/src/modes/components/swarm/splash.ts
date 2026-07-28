import { padding } from "@oh-my-pi/pi-tui";
import { PI_LOGO_ASCII, sato } from "./theme";

const LOGO_WIDTH = 41;
const MIN_WIDTH = 60;

/**
 * Render the SatoPi brand splash screen.
 *
 * Center: Pi logo ASCII art.
 * "SatoPi" text above the logo in amber bold.
 * Tagline below the box.
 */
export function renderSplash(width: number = 80): string[] {
	const w = Math.max(width, MIN_WIDTH);
	const innerW = w - 2;
	const border = sato.amber;
	const lines: string[] = [];

	// Top border
	lines.push(border(`╔${"═".repeat(innerW)}╗`));

	// Empty line
	lines.push(border(`║${padding(innerW)}║`));

	// "SatoPi" centered above the logo
	const nameStr = "S a t o P i";
	const namePad = Math.floor((w - 8) / 2);
	const nameLine = padding(Math.max(0, namePad - 6)) + sato.bold(sato.orange(nameStr));
	const nameRightPad = Math.max(0, innerW - (namePad + 8));
	lines.push(border("║") + nameLine + padding(nameRightPad) + border("║"));

	// Empty line between name and logo
	lines.push(border(`║${padding(innerW)}║`));

	// Pi logo — centered
	const logoPadLeft = Math.floor((innerW - LOGO_WIDTH) / 2);
	for (const logoLine of PI_LOGO_ASCII) {
		const trimmed = logoLine.length > LOGO_WIDTH ? logoLine.substring(0, LOGO_WIDTH) : logoLine.padEnd(LOGO_WIDTH);
		const padRight = innerW - logoPadLeft - LOGO_WIDTH;
		lines.push(
			border("║") +
				padding(Math.max(0, logoPadLeft)) +
				sato.dim(trimmed) +
				padding(Math.max(0, padRight)) +
				border("║"),
		);
	}

	// Empty line
	lines.push(border(`║${padding(innerW)}║`));

	// Bottom border
	lines.push(border(`╚${"═".repeat(innerW)}╝`));

	// Tagline below the box
	const tagline = "Satori a team of Pi · v0.0.1";
	const taglinePad = Math.max(0, Math.floor((w - tagline.length) / 2));
	lines.push(padding(taglinePad) + sato.dim(tagline));

	return lines;
}
