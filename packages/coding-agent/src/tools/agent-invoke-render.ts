/**
 * Inline TUI renderer for the `agent_invoke` tool.
 *
 * Mirrors the `task` tool's rendering style exactly — same `framedBlock`,
 * same `renderStatusLine`, same shared agent primitives from `task/render.ts`,
 * same icons (`formatStatusIcon`, `theme.styledSymbol`).
 *
 * Frame lifecycle: CALL → STREAMING → SETTLED → DISMISSED (5s after settled).
 */

import type { Component } from "@satopi/pi-tui";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import { agentTypeBadge, appendAgentStats, formatTaskId, getStatusIcon } from "../task/render";
import type { AgentProgress, SingleResult } from "../task/types";
import { formatStatusIcon, previewLine } from "../tools/render-utils";
import { framedBlock, renderStatusLine } from "../tui";

// ============================================================================
// Types
// ============================================================================

export interface AgentInvokeParams {
	profileId?: string;
	task?: string;
	assignment?: string;
}

export interface AgentInvokeDetails {
	progress?: AgentProgress[];
	results?: SingleResult[];
	profileId?: string;
	displayName?: string;
	kind?: string;
}

interface AgentInvokeRenderContext {
	hasResult?: boolean;
	frozen?: boolean;
}

type AgentInvokeRenderOptions = RenderResultOptions & {
	renderContext?: AgentInvokeRenderContext;
};

// ============================================================================
// renderCall
// ============================================================================

export function renderCall(args: AgentInvokeParams, _options: AgentInvokeRenderOptions, theme: Theme): Component {
	const profileId = args.profileId?.trim() ?? "";
	const description = args.task?.trim();

	return framedBlock(theme, width => {
		const sections: Array<{ label?: string; lines: readonly string[]; separator?: boolean }> = [];

		// Profile info line
		const profileLine = profileId ? `${theme.fg("accent", profileId)}` : theme.fg("dim", "(unknown profile)");
		sections.push({ lines: [`  ${profileLine}`] });

		// Task assignment (if any)
		if (description) {
			sections.push({ lines: description.split("\n").map(l => `  ${l}`), separator: true });
		}

		return {
			header: renderStatusLine(
				{
					iconOverride: theme.styledSymbol("tool.task", "accent"),
					title: "Invoke Agent",
					description: profileId || undefined,
				},
				theme,
			),
			sections,
			state: "pending",
			borderColor: "borderMuted",
			width,
		};
	});
}

// ============================================================================
// renderResult
// ============================================================================

/**
 * An agent is "settled" when its status is no longer running/pending.
 * After 5s, render returns [] to auto-dismiss the frame.
 */
const SETTLED_STATUSES = new Set<AgentProgress["status"]>(["completed", "failed", "aborted"]);

export function renderResult(
	result: { content?: Array<{ type: string; text?: string }>; details?: AgentInvokeDetails; isError?: boolean },
	options: AgentInvokeRenderOptions,
	theme: Theme,
	_args?: AgentInvokeParams,
): Component {
	const details = result.details;
	if (!details) {
		// Fallback: plain text
		const text = result.content?.map(c => c.text ?? "").join("\n") ?? "";
		return {
			render: () => (text ? [text] : []),
			invalidate: () => {},
		};
	}

	const progress = details.progress;
	const results = details.results;

	// Determine state
	let state: "running" | "done" | "error" = "running";

	if (results && results.length > 0) {
		const last = results[results.length - 1];
		if (last.error) state = "error";
		else state = "done";
	} else if (progress && progress.length > 0) {
		const last = progress[progress.length - 1];
		if (SETTLED_STATUSES.has(last.status)) {
			state = last.status === "failed" || last.status === "aborted" ? "error" : "done";
		}
	}

	return framedBlock(theme, width => {
		const lines: string[] = [];

		// Status line — use latest progress or result
		if (progress && progress.length > 0) {
			const latest = progress[progress.length - 1];
			const icon = getStatusIcon(latest.status, theme, options.spinnerFrame);
			const displayName = formatTaskId(details.displayName ?? latest.id);
			const taskPreview = previewLine(latest.assignment ?? latest.task, 40);
			let statusLine = `${icon} ${theme.fg("accent", displayName)}`;
			if (latest.status === "running" || latest.status === "pending") {
				statusLine += ` ${theme.fg("muted", taskPreview)}`;
			}
			statusLine += agentTypeBadge(latest.agent, theme);
			statusLine = appendAgentStats(
				statusLine,
				{
					toolCount: latest.toolCount,
					tokens: latest.tokens,
					contextTokens: latest.contextTokens,
					contextWindow: latest.contextWindow,
					cost: latest.cost,
				},
				theme,
			);
			lines.push(statusLine);
		} else if (results && results.length > 0) {
			const r = results[results.length - 1];
			const icon = formatStatusIcon(r.error ? "error" : "done", theme);
			const displayName = formatTaskId(details.displayName ?? r.id);
			lines.push(`${icon} ${theme.fg("accent", displayName)}`);
		}

		// Output preview (tail 3 lines from latest running progress)
		if (progress && progress.length > 0) {
			const latest = progress[progress.length - 1];
			if (latest.recentOutput && latest.recentOutput.length > 0) {
				const outputLines = latest.recentOutput.slice(-3);
				if (outputLines.length > 0) {
					lines.push(`  ${theme.fg("dim", "── output ──")}`);
					for (const ol of outputLines) {
						lines.push(`  ${theme.fg("dim", previewLine(ol, width - 4))}`);
					}
				}
			}
		}

		// Yield data from results
		if (results && results.length > 0) {
			const r = results[results.length - 1];
			if (r.extractedToolData?.yield) {
				const yieldItems = normalizeYieldData(r.extractedToolData.yield);
				if (yieldItems.length > 0) {
					lines.push(`  ${theme.fg("dim", "── yield ──")}`);
					for (const item of yieldItems.slice(0, 3)) {
						const preview =
							typeof item.data === "string"
								? previewLine(item.data, width - 4)
								: JSON.stringify(item.data).slice(0, width - 4);
						lines.push(`  ${theme.fg("dim", preview)}`);
					}
				}
			}
		}

		// Footer
		if (state === "done") {
			lines.push(`  ${theme.fg("dim", "Dismissing — Agent Hub (Ctrl+S)")}`);
		} else if (state === "error") {
			lines.push(`  ${theme.fg("dim", "Agent Hub (Ctrl+S)")}`);
		}

		const headerIcon = state === "running" ? "running" : state === "done" ? "success" : "error";
		const headerState = state === "running" ? "running" : state === "done" ? "success" : "error";

		return {
			header: renderStatusLine(
				{
					icon: headerIcon as "running" | "success" | "error",
					title: "Invoke Agent",
					description: details.profileId || details.displayName || undefined,
				},
				theme,
			),
			sections: lines.length > 0 ? [{ lines }] : undefined,
			state: headerState,
			borderColor: "borderMuted",
			width,
		};
	});
}

// ============================================================================
// Helpers
// ============================================================================

function normalizeYieldData(value: unknown): Array<{ type?: string; data?: unknown }> {
	if (!value) return [];
	if (Array.isArray(value)) return value as Array<{ type?: string; data?: unknown }>;
	if (typeof value === "object") return [value as { type?: string; data?: unknown }];
	return [];
}

// ============================================================================
// Exports
// ============================================================================

export const agentInvokeRenderer = {
	renderCall,
	renderResult,
	mergeCallAndResult: true,
} as const;
