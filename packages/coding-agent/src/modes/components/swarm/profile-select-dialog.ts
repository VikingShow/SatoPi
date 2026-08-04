/**
 * ProfileSelectDialog — Multi-select dialog for choosing agent profiles for a crew.
 *
 *   j / Down — move cursor down
 *   k / Up   — move cursor up
 *   Space    — toggle selection
 *   Enter    — confirm (requires >= 2 selected)
 *   Esc / q  — cancel
 *
 * The trailing "+ Create new agent" row opens a self-contained draft-name
 * mode (Enter to create via the global ProfileRegistry, Esc to cancel):
 *   a-z / A-Z / 0-9 — append to the draft name
 *   Backspace        — delete last character
 *   Enter            — create the profile, select it, exit draft mode
 *   Esc              — cancel drafting
 */

import { type Component, matchesKey } from "@satopi/pi-tui";
import { getProjectDir } from "@satopi/pi-utils";
import { deriveProfileId, ProfileRegistry, validateProfileId } from "../../../agent/agent-profile";
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
	/** Draft-name mode for "+ Create new agent" (Enter on the trailing row). */
	#draftMode = false;
	#draftName = "";
	#draftError: string | null = null;

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

		// Items (plus the trailing "+ Create new agent" row)
		if (this.#items.length === 0) {
			const msg = "  No agent profiles available (minimum 2 required)";
			out.push(
				`${t.fg(bc, "\u2502")}${t.fg("dim", msg)}${" ".repeat(Math.max(0, inner - visibleLen(msg)))}${t.fg(bc, "\u2502")}`,
			);
		}
		const totalRows = this.#items.length + 1;
		const maxVis = Math.min(totalRows, 16);
		const start = Math.max(0, Math.min(this.#cursorIdx - Math.floor(maxVis / 2), totalRows - maxVis));

		for (let i = start; i < start + maxVis; i++) {
			if (i >= this.#items.length) {
				// Trailing create row — replaced by the draft input in draft mode.
				if (this.#draftMode) continue;
				const isCur = i === this.#cursorIdx;
				const cursor = isCur ? t.fg("accent", "\u25b6") : " ";
				const body = `${cursor} ${t.fg(isCur ? "accent" : "dim", "+ Create new agent")}`;
				const pad = Math.max(0, inner - visibleLen(body));
				out.push(`${t.fg(bc, "\u2502")}${body}${" ".repeat(pad)}${t.fg(bc, "\u2502")}`);
				continue;
			}

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

		// Draft-name mode: input row + inline error (stays on failure).
		if (this.#draftMode) {
			const input = ` New agent name: ${this.#draftName}\u258f `;
			const iPad = Math.max(0, inner - visibleLen(input));
			out.push(`${t.fg(bc, "\u2502")}${t.fg("accent", input)}${" ".repeat(iPad)}${t.fg(bc, "\u2502")}`);
			if (this.#draftError) {
				const warn = ` \u26a0 ${this.#draftError}`.slice(0, inner - 2);
				const wPad = Math.max(0, inner - visibleLen(warn));
				out.push(`${t.fg(bc, "\u2502")}${t.fg("warning", warn)}${" ".repeat(wPad)}${t.fg(bc, "\u2502")}`);
			}
		}

		// Footer divider
		out.push(`${t.fg(bc, "\u251c")}${t.fg(bc, "\u2500".repeat(inner))}${t.fg(bc, "\u2524")}`);
		// Footer
		const n = this.#items.filter(x => x.selected).length;
		const hint = this.#draftMode
			? ` Enter to create \u00b7 Esc to cancel `
			: n >= MIN_SELECTED
				? ` ${n} selected \u2014 Enter to confirm `
				: ` Select at least ${MIN_SELECTED} (${n} selected) `;
		const footer = `${hint}${this.#draftMode ? "" : t.fg("dim", "Esc/q to cancel")}`;
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

		// Draft-name mode: collect the new agent's name in the dialog itself.
		if (this.#draftMode) {
			if (/^[a-zA-Z0-9]$/.test(data)) {
				if (this.#draftName.length < 40) this.#draftName += data;
			} else if (matchesKey(data, "backspace")) {
				this.#draftName = this.#draftName.slice(0, -1);
			} else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
				void this.#confirmCreate();
			} else if (matchesKey(data, "escape")) {
				this.#draftMode = false;
				this.#draftName = "";
				this.#draftError = null;
			}
			return;
		}

		if (matchesKey(data, "up") || data === "k") {
			this.#cursorIdx = Math.max(0, this.#cursorIdx - 1);
		} else if (matchesKey(data, "down") || data === "j") {
			this.#cursorIdx = Math.min(this.#items.length, this.#cursorIdx + 1);
		} else if (matchesKey(data, "space") || data === " ") {
			if (this.#cursorIdx >= 0 && this.#cursorIdx < this.#items.length) {
				this.#items[this.#cursorIdx].selected = !this.#items[this.#cursorIdx].selected;
			}
		} else if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			if (this.#cursorIdx === this.#items.length) {
				// "+ Create new agent" row → draft-name mode.
				this.#draftMode = true;
				this.#draftName = "";
				this.#draftError = null;
				return;
			}
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

	/**
	 * Confirm the draft name: derive a safe profileId, create the profile via
	 * the global registry, persist it, and refresh the local item list with the
	 * new agent preselected. On failure (e.g. duplicate id) the error is shown
	 * inline and the dialog stays in draft mode.
	 */
	async #confirmCreate(): Promise<void> {
		const name = this.#draftName.trim();
		if (!name) {
			this.#draftError = "Name cannot be empty";
			return;
		}
		const profileId = deriveProfileId(name);
		if (!validateProfileId(profileId)) {
			this.#draftError = "Name must contain at least one letter or digit (A-Z, a-z, 0-9, -, _)";
			return;
		}
		try {
			const profile = ProfileRegistry.global().createProfile({
				profileId,
				name,
				archetype: "worker",
			});
			// Refresh the list synchronously (the new item is preselected);
			// persistence is best-effort (save swallows failures internally).
			this.#items.push({
				profileId: profile.profileId,
				name: profile.identity.name,
				archetype: profile.identity.archetype,
				creditScore: profile.credit.score,
				successRate: profile.credit.successRate,
				domains: profile.expertise.domains,
				selected: true,
				warned: profile.credit.score < 30,
			});
			this.#cursorIdx = this.#items.length - 1;
			this.#draftMode = false;
			this.#draftName = "";
			this.#draftError = null;
			await ProfileRegistry.global().save(getProjectDir());
		} catch (err) {
			this.#draftError = err instanceof Error ? err.message : String(err);
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
