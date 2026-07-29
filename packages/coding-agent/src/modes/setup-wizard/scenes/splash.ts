import { padding, truncateToWidth, visibleWidth } from "@satopi/pi-tui";
import { gradientLogo, PI_LOGO, type ShineConfig } from "../../components/welcome";
import { theme } from "../../theme/theme";

export const SETUP_SPLASH_MS = 2600;
export const SETUP_TICK_MS = 33;

const SKIP_HINT = "press enter to skip";

function clampLine(line: string, width: number): string {
	const truncated = truncateToWidth(line, width);
	return truncated + padding(Math.max(0, width - visibleWidth(truncated)));
}

function centerLine(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	if (lineWidth >= width) return truncateToWidth(line, width);
	const left = Math.floor((width - lineWidth) / 2);
	return padding(left) + line + padding(width - left - lineWidth);
}

export function renderSetupSplash(width: number, height: number, elapsedMs: number): string[] {
	const w = Math.max(1, width);
	const h = Math.max(1, height);

	// Animated gradient splash for all terminal sizes
	const progress = Math.max(0, Math.min(1, elapsedMs / SETUP_SPLASH_MS));
	const phase = progress * 1.8;
	const shine: ShineConfig = { pos: (progress * 2.5) % 1, strength: Math.max(0, 1 - progress * 0.35) };
	return renderCompactSplash(w, h, phase, shine);
}

function renderCompactSplash(width: number, height: number, phase: number, shine: ShineConfig): string[] {
	const art = PI_LOGO;
	const content = [
		...gradientLogo(art, phase, shine),
		"",
		theme.bold("S a t o P i"),
		"",
		theme.fg("dim", "Satori a team of Pi · v0.0.1"),
	];
	const start = Math.max(0, Math.floor((height - content.length) / 2));
	const lines: string[] = [];
	for (let y = 0; y < height; y++) {
		const item = content[y - start];
		lines.push(clampLine(item !== undefined ? centerLine(item, width) : "", width));
	}
	if (height > 2) lines[height - 2] = clampLine(centerLine(theme.fg("dim", SKIP_HINT), width), width);
	return lines;
}
