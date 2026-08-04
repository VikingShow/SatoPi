/**
 * interactive-render-utils.ts — stateless render helpers for interactive mode
 * (stage 5 split). Extracted from modes/interactive-mode.ts module-level scope.
 */

import { visibleWidth } from "@satopi/pi-tui";
import { formatNumber } from "@satopi/pi-utils";
import chalk from "chalk";
import { formatTaskId } from "../../task/render";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import { renderTreeList } from "../../tui/tree-list";
import type { ObservableSession } from "../session-observer-registry";
import { type ThemeColor, theme } from "../theme/theme";

/** How long the ctrl+p model-role cycle chip track lingers above the editor
 *  before it auto-clears, mirroring the todo HUD's auto-clear timer. */
export const MODEL_CYCLE_TRACK_CLEAR_MS = 4000;
export const SUBAGENT_HUD_VISIBLE_LIMIT = 8;
export const SUBAGENT_OBSERVER_UI_COALESCE_MS = 100;

/** Editor height cap constants shared with computeEditorMaxHeight. */
export const EDITOR_MAX_HEIGHT_MIN = 6;
export const EDITOR_MAX_HEIGHT_MAX = 18;
export const EDITOR_RESERVED_ROWS = 12;
export const EDITOR_FALLBACK_ROWS = 24;
export const EDITOR_MIN_CHROME_ROWS = 4; // rows reserved for transcript + status on small terms
export const EDITOR_MIN_RENDERED_ROWS = 3; // bordered editor floor: top+bottom border + 1 content row

/**
 * Compute the max height (in rows) the editor should use for the current
 * terminal height.
 *
 * Roomy terminals get the comfortable [6, 18] band. Small terminals shrink the
 * cap so the editor leaves at least EDITOR_MIN_CHROME_ROWS rows for the
 * transcript + status line. The editor is bordered, so it never renders fewer
 * than EDITOR_MIN_RENDERED_ROWS rows; once the terminal is too small for both
 * (terminalRows < EDITOR_MIN_RENDERED_ROWS + EDITOR_MIN_CHROME_ROWS) the cap is
 * pinned to that floor — returning a smaller number would not shrink the editor
 * any further, it would only misreport the rows it actually occupies.
 */
export function computeEditorMaxHeight(terminalRows: number): number {
	const rows = Number.isFinite(terminalRows) && terminalRows > 0 ? terminalRows : EDITOR_FALLBACK_ROWS;
	const comfortable = Math.max(EDITOR_MAX_HEIGHT_MIN, Math.min(EDITOR_MAX_HEIGHT_MAX, rows - EDITOR_RESERVED_ROWS));
	return Math.max(EDITOR_MIN_RENDERED_ROWS, Math.min(comfortable, rows - EDITOR_MIN_CHROME_ROWS));
}

const HUD_NOTE_SUP_DIGITS: Record<string, string> = {
	"0": "\u2070",
	"1": "\u00b9",
	"2": "\u00b2",
	"3": "\u00b3",
	"4": "\u2074",
	"5": "\u2075",
	"6": "\u2076",
	"7": "\u2077",
	"8": "\u2078",
	"9": "\u2079",
};

export function formatHudNoteMarker(count: number): string {
	if (count <= 0) return "";
	const sub = String(count)
		.split("")
		.map(d => HUD_NOTE_SUP_DIGITS[d] ?? d)
		.join("");
	return theme.fg("dim", chalk.italic(` \u207a${sub}`));
}

export type GoalSubcommand = "set" | "show" | "pause" | "resume" | "drop" | "budget";

export const GOAL_SUBCOMMANDS = new Set<GoalSubcommand>(["set", "show", "pause", "resume", "drop", "budget"]);
export const PLAN_KEEP_CONTEXT_OPTION_INDEX = 2;
export const PLAN_KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT = 95;

export function parseGoalSubcommand(args: string): { sub: GoalSubcommand | undefined; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { sub: undefined, rest: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return { sub: undefined, rest: trimmed };
	const first = match[1].toLowerCase();
	if (GOAL_SUBCOMMANDS.has(first as GoalSubcommand)) {
		return { sub: first as GoalSubcommand, rest: match[2]?.trim() ?? "" };
	}
	return { sub: undefined, rest: trimmed };
}

export function formatContextTokenCount(value: number): string {
	return formatNumber(Math.max(0, Math.round(value))).toLowerCase();
}

/** Shared wrapper: bold coloured title + rows, each indented one space. Empty rows → empty array. */
export function renderAgentHud(title: string, titleColor: ThemeColor, rows: string[]): string[] {
	if (rows.length === 0) return [];
	return ["", theme.bold(theme.fg(titleColor, title)), ...rows.map(line => ` ${line}`)];
}

/**
 * Subagent-only HUD block — accent "Subagents" header. Only lists detached
 * task subagents; persistent agents (sentinel `persist-` id prefix) are excluded.
 */
export function renderSubagentHudLines(sessions: ObservableSession[], columns: number): string[] {
	const running = sessions.filter(
		session => session.kind === "subagent" && session.status === "active" && session.detached === true,
	);
	if (running.length === 0) return [];

	const pDot = theme.styledSymbol("status.done", "thinkingMedium");
	const sDot = theme.styledSymbol("status.done", "accent");
	const visible = running.slice(0, SUBAGENT_HUD_VISIBLE_LIMIT);
	const hiddenCount = running.length - visible.length;
	const rows = renderTreeList(
		{
			items: visible,
			expanded: true,
			renderItem: session => {
				const isPersistent = session.id.startsWith("persist-");
				const dot = isPersistent ? pDot : sDot;
				const color: ThemeColor = isPersistent ? "thinkingMedium" : "accent";
				const displayId = isPersistent
					? session.description?.trim() || session.id.replace(/^persist-/, "")
					: formatTaskId(session.id);
				let line = `${dot} ${theme.fg(color, theme.bold(displayId))}`;
				const description = session.description?.trim() || session.progress?.description?.trim();
				if (description && !isPersistent) {
					const budget = Math.max(TRUNCATE_LENGTHS.SHORT, columns - visibleWidth(displayId) - 10);
					line += `${theme.fg(color, ":")} ${theme.fg(color, truncateToWidth(replaceTabs(description), budget))}`;
				} else {
					const taskPreview = session.progress?.task?.trim();
					if (taskPreview) {
						line += ` ${theme.fg("muted", truncateToWidth(replaceTabs(taskPreview), TRUNCATE_LENGTHS.SHORT))}`;
					}
				}
				return line;
			},
		},
		theme,
	);
	if (hiddenCount > 0) {
		rows.push(theme.fg("dim", `… ${hiddenCount} more running — open Agent Hub for full list`));
	}
	return renderAgentHud("Subagents", "accent", rows);
}
