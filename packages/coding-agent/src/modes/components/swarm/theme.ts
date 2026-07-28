/**
 * Swarm TUI theme — SatoPi brand colour helpers built on chalk.
 *
 * Uses chalk.hex() for all colours — no dependency on the heavy
 * modes/theme/theme.ts module (which requires full app initialisation).
 * Chalk auto-detects terminal support and produces ANSI codes that
 * work identically to the theme system.
 *
 * The hex values match the satopi.json theme file where there is a
 * direct correspondence (success → bodhiGreen, error → softRed, etc.).
 * Brand-only colours (purple, info blue, logo orange) use SatoPi
 * GUI design tokens.
 */

import chalk from "chalk";
import type { Chapter } from "../../../swarm/core/state";

// ============================================================================
// Colour helpers — chalk.hex wrappers
// ============================================================================

export const sato = {
	// ── Semantic (matches satopi.json theme) ──────────────────────────────
	success: (text: string) => chalk.hex("#6D9E6B")(text), // bodhiGreen
	error: (text: string) => chalk.hex("#CC7A72")(text), // softRed
	/** Alias for error — panels use both names. */
	danger: (text: string) => chalk.hex("#CC7A72")(text), // softRed
	warning: (text: string) => chalk.hex("#D8B860")(text), // warmGold
	muted: (text: string) => chalk.hex("#8B9098")(text), // inkMuted
	dim: (text: string) => chalk.hex("#555B64")(text), // inkDim
	text: (text: string) => chalk.hex("#E2E4EA")(text), // inkText
	border: (text: string) => chalk.hex("#2A3038")(text), // inkBorder
	bold: (text: string) => chalk.bold(text),
	amber: (text: string) => chalk.hex("#C8A24E")(text), // bodhiGold / accent

	// ── Brand-invariant (no ThemeColor equivalent) ───────────────────────
	/** Blue — script phase, agent info lines. */
	info: (text: string) => chalk.hex("#3B82F6")(text),
	/** Purple — debate/curtain phases. */
	purple: (text: string) => chalk.hex("#8B5CF6")(text),
	/** Logo orange — "SatoPi" name. */
	orange: (text: string) => chalk.hex("#F97316")(text),
};

// ============================================================================
// Theme-bridge factory
// ============================================================================

import type { Theme } from "../../theme/theme";

/**
 * Create SatoPi swarm dashboard colour helpers from the main TUI Theme.
 *
 * Prefer this over the static `sato` object when a Theme instance is available
 * (e.g. in SwarmDashboardOverlay).  Brand colours without a ThemeColor key
 * (info, purple, orange) fall back to the static chalk.hex helpers below.
 */
export function createSatoFromTheme(theme: Theme) {
	return {
		success: (text: string) => theme.fg("success", text),
		error: (text: string) => theme.fg("error", text),
		danger: (text: string) => theme.fg("error", text),
		warning: (text: string) => theme.fg("warning", text),
		muted: (text: string) => theme.fg("muted", text),
		dim: (text: string) => theme.fg("dim", text),
		text: (text: string) => theme.fg("text", text),
		border: (text: string) => theme.fg("border", text),
		bold: (text: string) => theme.bold(text),
		amber: (text: string) => theme.fg("accent", text),
		// Brand colours — no ThemeColor equivalents; fall back to chalk.hex
		info: sato.info,
		purple: sato.purple,
		orange: sato.orange,
	};
}

// ============================================================================
// Phase lifecycle visualisation
// ============================================================================

export const PHASE_DISPLAY: Record<Chapter, { icon: string; label: string }> = {
	idle: { icon: "○", label: "Idle" },
	script: { icon: "◇", label: "Script" },
	"script-debate": { icon: "◆", label: "Debate" },
	"script-confirm": { icon: "◇", label: "Confirm" },
	stage: { icon: "●", label: "Stage" },
	paused: { icon: "⏸", label: "Paused" },
	blocked: { icon: "⛔", label: "Blocked" },
	curtain: { icon: "◈", label: "Curtain" },
};

/** Phase → colour function. */
export function phaseColor(phase: Chapter): (text: string) => string {
	switch (phase) {
		case "script":
		case "script-confirm":
			return sato.info;
		case "script-debate":
		case "curtain":
			return sato.purple;
		case "stage":
			return sato.amber;
		case "paused":
			return sato.warning;
		case "blocked":
			return sato.error;
		default:
			return sato.muted;
	}
}

// ============================================================================
// SatoPi ASCII logo
// ============================================================================

export const PI_LOGO_ASCII: string[] = [
	"              ●            ●              ",
	"        ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄        ",
	"        ██                        ██        ",
	"        ██                        ██        ",
	"        ██                        ██        ",
	"        ██           ▄▄▄▄         ██        ",
	"        ██           ████         ██        ",
	"        ██           ▀▀▀▀         ██        ",
	"        ██                        ██        ",
	"        ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀        ",
];
