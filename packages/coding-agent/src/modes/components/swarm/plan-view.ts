/**
 * Plan View — renders the current plan's phase/task structure as a bordered
 * TUI panel using the shared `swarmPanel` wrapper.
 *
 * Uses `parsePlanSections` from plan-toc.ts to split plan.md into sections,
 * then renders only ## Phase (level 2) and ### Task (level 3) headings.
 * Preamble and top-level `#` titles are skipped.
 */

import type { Component } from "@satopi/pi-tui";
import type { Theme } from "../../theme/theme";
import { parsePlanSections } from "../plan-toc";
import { swarmPanel } from "./swarm-panel-block";

// ============================================================================
// Public API
// ============================================================================

/**
 * Render the plan content as a pi-tui `Component` (framed block).
 * Shows the plan's phase headings and task sub-headings in a compact
 * structured summary — no full markdown rendering.
 */
export function renderPlanPanel(planContent: string | undefined, theme: Theme): Component {
	return swarmPanel(
		"Plan",
		({ innerWidth: _, theme: t }) => {
			if (!planContent || planContent.trim().length === 0) {
				return [t.fg("dim", "  (no plan loaded)")];
			}

			const sections = parsePlanSections(planContent);
			const lines: string[] = [];

			for (const section of sections) {
				// Skip preamble (level 0) and top-level title (level 1)
				if (section.level <= 1) continue;
				// Only render ## Phase (level 2) and ### Task (level 3)
				if (section.level > 3) continue;

				if (section.level === 2) {
					lines.push(t.bold(t.fg("accent", section.title)));
				} else {
					// level 3 — Task sub-heading
					lines.push(`  ${t.fg("dim", "▸")} ${section.title}`);
				}
			}

			if (lines.length === 0) {
				return [t.fg("dim", "  (no phases defined)")];
			}

			return lines;
		},
		theme,
	);
}
