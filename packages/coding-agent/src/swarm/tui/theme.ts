import type { Chapter } from "../core/state";

/** SatoPi brand color palette — adapted from swarm-gui CSS design tokens */
export const SATOPI_COLORS = {
	primary: { hex: "#F59E0B", ansi256: 214, name: "amber" },
	primaryBg: { hex: "#D97706", ansi256: 172, name: "amber-dark" },
	background: { hex: "#0A0A0A", ansi256: 0, name: "near-black" },
	surface: { hex: "#141414", ansi256: 233, name: "dark-gray" },
	surface2: { hex: "#1C1C1C", ansi256: 234, name: "elevated" },
	text: { hex: "#FAFAFA", ansi256: 255, name: "near-white" },
	muted: { hex: "#A3A3A3", ansi256: 248, name: "dim-text" },
	border: { hex: "#262626", ansi256: 235, name: "border" },
	success: { hex: "#22C55E", ansi256: 41, name: "green" },
	warning: { hex: "#F59E0B", ansi256: 214, name: "amber" },
	danger: { hex: "#EF4444", ansi256: 203, name: "red" },
	info: { hex: "#3B82F6", ansi256: 69, name: "blue" },
	purple: { hex: "#8B5CF6", ansi256: 99, name: "purple" },
	logoOrange: { hex: "#F97316", ansi256: 208, name: "orange" },
	logoWhite: { hex: "#FAFAFA", ansi256: 255, name: "white" },
	logoDark: { hex: "#0D0D0D", ansi256: 232, name: "logo-dark" },
} as const;

// ANSI color helpers
export function ansiFg(code: number, text: string): string {
	return `\x1b[38;5;${code}m${text}\x1b[0m`;
}
export function ansiBold(text: string): string {
	return `\x1b[1m${text}\x1b[0m`;
}
export function ansiDim(text: string): string {
	return `\x1b[2m${text}\x1b[0m`;
}

/** Phase color + icon mapping for lifecycle visualization */
export const PHASE_DISPLAY: Record<
	Chapter,
	{ color: (typeof SATOPI_COLORS)[keyof typeof SATOPI_COLORS]; icon: string; label: string }
> = {
	idle: { color: SATOPI_COLORS.muted, icon: "○", label: "Idle" },
	script: { color: SATOPI_COLORS.info, icon: "◇", label: "Script" },
	"script-debate": { color: SATOPI_COLORS.purple, icon: "◆", label: "Debate" },
	"script-confirm": { color: SATOPI_COLORS.success, icon: "◇", label: "Confirm" },
	stage: { color: SATOPI_COLORS.primary, icon: "●", label: "Stage" },
	paused: { color: SATOPI_COLORS.warning, icon: "⏸", label: "Paused" },
	blocked: { color: SATOPI_COLORS.danger, icon: "⛔", label: "Blocked" },
	curtain: { color: SATOPI_COLORS.purple, icon: "◈", label: "Curtain" },
};

/** SatoPi logo — hand-crafted from hero.png shape using box-drawing & block chars */
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
