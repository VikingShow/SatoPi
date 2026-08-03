/**
 * ProfileSelectDialog — Multi-select dialog for choosing agent profiles for a crew.
 *
 * Keyboard:
 *   j / Down — move cursor down
 *   k / Up   — move cursor up
 *   Space    — toggle selection
 *   Enter    — confirm (requires >= 2 selected)
 *   Esc / q  — cancel
 */

import { type Component, matchesKey } from "@satopi/pi-tui";
import type { Theme } from "../../theme/theme";

// ============================================================================
// Types
// ============================================================================

export interface ProfileSelectItem {
	profileId: string;
	name: string;
	archetype: string;
	creditScore: number;
	successRate: number;
	domains: string[];
	selected: boolean;
	warned: boolean;
}

// ============================================================================
// ProfileSelectDialog
// ============================================================================

const MIN_SELECTED = 2;

export class ProfileSelectDialog implements Component {
	readonly #items: ProfileSelectItem[];
	readonly #theme: Theme;
	readonly #onConfirm: (selected: string[]) => void;
	readonly #onCancel: () => void;
	#cursorIdx = 0;
	#invalidAttempt = false;
	#closed = false;

	constructor(
		items: ProfileSelectItem[],
		theme: Theme,
		onConfirm: (selected: string[]) => void,
		onCancel: () => void,
	) {
		this.#items = items;
		this.#theme = theme;
		this.#onConfirm = onConfirm;
		this.#onCancel = onCancel;
	}

	invalidate(): void {}

	dispose(): void {
		this.#closed = true;
	}

	render(width: number): readonly string[] {
		const t = this.#theme;
		const inner = Math.max(20, Math.min(70, width - 4));
		const bc = "borderAccent" as const;

		const out: string[] = [];

		// Top border
		out.push(t.fg(bc, `${"\u250c"}${"\u2500".repeat(inner)}${"\u2510"}`));

		// Header
		const hdr = " Select Agents for Crew ";
		const hPad = "\u2500".repeat(Math.max(0, inner - hdr.length));
		out.push(`${t.fg(bc, "\u2502")}${t.bold(t.fg("accent", hdr + hPad))}${t.fg(bc, "\u2502")}`);

		// Divider
		out.push(`${t.fg(bc, "\u251c")}${t.fg(bc, "\u2500".repeat(inner))}${t.fg(bc, "\u2524")}`);

		// Items
		if (this.#items.length === 0) {
			const msg = "  No agent profiles available (minimum 2 required)";
			out.push(
				`${t.fg(bc, "\u2502")}${t.fg("dim", msg)}${" ".repeat(Math.max(0, inner - 50))}${t.fg(bc, "\u2502")}`,
			);
		} else {
			const maxVis = Math.min(this.#items.length, 16);
			const start = Math.max(0, Math.min(this.#cursorIdx - Math.floor(maxVis / 2), this.#items.length - maxVis));

			for (let i = start; i < start + maxVis; i++) {
				const item = this.#items[i];
				const isCur = i === this.#cursorIdx;
				const on = item.selected;

				const cursor = isCur ? t.fg("accent", "\u25b6") : " ";
				const check = on ? t.fg("accent", "\u2713") : " ";
				const nc = isCur || on ? ("accent" as const) : ("dim" as const);
				const sc =
					item.creditScore >= 70
						? ("accent" as const)
						: item.creditScore >= 50
							? ("dim" as const)
							: ("warning" as const);

				const name = item.name.padEnd(16).slice(0, 16);
				const arch = (item.archetype || "-").padEnd(10).slice(0, 10);
				const score = `${"\u2605"}${item.creditScore}`;
				const rate = `${Math.round(item.successRate * 100)}%`;

				const warnMarker = item.warned ? " \u26a0" : "";
				const body = `${cursor}${check} ${t.fg(nc, name)} ${arch} ${t.fg(sc, score)} ${t.fg("dim", rate)}${warnMarker}`;
				const pad = Math.max(0, inner - visibleLen(body));
				out.push(`${t.fg(bc, "\u2502")}${body}${" ".repeat(pad)}${t.fg(bc, "\u2502")}`);
			}
		}

		// Footer divider
		out.push(`${t.fg(bc, "\u251c")}${t.fg(bc, "\u2500".repeat(inner))}${t.fg(bc, "\u2524")}`);
		// Footer
		const n = this.#items.filter(x => x.selected).length;
		const hint =
			n >= MIN_SELECTED
				? ` ${n} selected \u2014 Enter to confirm `
				: ` Select at least ${MIN_SELECTED} (${n} selected) `;
		const footer = `${hint}${t.fg("dim", "Esc/q to cancel")}`;
		const fPad = Math.max(0, inner - visibleLen(footer));
		out.push(`${t.fg(bc, "\u2502")}${footer}${" ".repeat(fPad)}${t.fg(bc, "\u2502")}`);

		// Invalid-attempt warning (flashed for one render cycle)
		if (this.#invalidAttempt) {
			this.#invalidAttempt = false;
			const warn = ` Select at least ${MIN_SELECTED} agents before confirming `;
			const wPad = Math.max(0, inner - visibleLen(warn));
			out.push(`${t.fg(bc, "\u251c")}${t.fg(bc, "\u2500".repeat(inner))}${t.fg(bc, "\u2524")}`);
			out.push(`${t.fg(bc, "\u2502")}${t.fg("warning", warn)}${" ".repeat(wPad)}${t.fg(bc, "\u2502")}`);
		}

		// Bottom border
		out.push(t.fg(bc, `${"\u2514"}${"\u2500".repeat(inner)}${"\u2518"}`));

		return out;
	}

	handleInput(data: string): void {
		if (this.#closed) return;

		if (matchesKey(data, "up") || data === "k") {
			if (this.#items.length > 0) {
				this.#cursorIdx = Math.max(0, this.#cursorIdx - 1);
			}
		} else if (matchesKey(data, "down") || data === "j") {
			if (this.#items.length > 0) {
				this.#cursorIdx = Math.min(this.#items.length - 1, this.#cursorIdx + 1);
			}
		} else if (matchesKey(data, "space") || data === " ") {
			if (this.#cursorIdx >= 0 && this.#cursorIdx < this.#items.length) {
				this.#items[this.#cursorIdx].selected = !this.#items[this.#cursorIdx].selected;
			}
		} else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const selected = this.#items.filter(x => x.selected).map(x => x.profileId);
			if (selected.length >= MIN_SELECTED) {
				this.#closed = true;
				this.#onConfirm(selected);
			} else {
				this.#invalidAttempt = true;
			}
		} else if (matchesKey(data, "escape") || data === "q") {
			this.#closed = true;
			this.#onCancel();
		}
	}

	focus(): void {
		// Overlay system manages focus.
	}

	blur(): void {
		// Overlay teardown handles cleanup.
	}
}

// ============================================================================
// Helpers
// ============================================================================

function visibleLen(s: string): number {
	return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
