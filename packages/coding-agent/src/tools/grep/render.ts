/**
 * tools/grep/render.ts — TUI renderer for the grep tool (stage 3 split).
 * Extracted from tools/grep.ts; class + schema stay in ./index.ts.
 */

import type { Component } from "@satopi/pi-tui";
import { Text } from "@satopi/pi-tui";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import {
	Ellipsis,
	fileHyperlink,
	getTreeBranch,
	getTreeContinuePrefix,
	renderStatusLine,
	renderTreeList,
	truncateToWidth,
	tryResolveInternalUrlSync,
	uriHyperlink,
} from "../../tui";
import type { GrepToolDetails } from "../grep";
import { classifyGroupedLines, groupLineIndicesByBlank } from "../grouped-file-output";
import { toPathList } from "../path-utils";
import {
	createCachedComponent,
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	formatMoreItems,
	PREVIEW_LIMITS,
	replaceTabs,
} from "../render-utils";

interface GrepRenderArgs {
	pattern: string;
	path?: string | string[];
	/** Legacy pre-`path` argument name; kept so historical transcripts still render a scope. */
	paths?: string | string[];
	case?: boolean;
	gitignore?: boolean;
	skip?: number;
}

const COLLAPSED_TEXT_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;
/** Line budget for the expanded view. Larger than collapsed so expanding
 * reveals more matches with context, but still bounded so a single hot file
 * whose matches span the whole file can't dump its entire length. */
const EXPANDED_TEXT_LIMIT = PREVIEW_LIMITS.EXPANDED_LINES * 2;

const SEARCH_CODE_FRAME_LINE_RE = /^\s*\*?(\d+)│/;

function searchScopeMeta(details: GrepToolDetails | undefined): string | undefined {
	if (!details?.scopePath) return undefined;
	const label = details.searchPath ? fileHyperlink(details.searchPath, details.scopePath) : details.scopePath;
	return `in ${label}`;
}

function linkUrlLikeSearchHeader(raw: string, styled: string): { line: string; absPath?: string } {
	const resolvedPath = tryResolveInternalUrlSync(raw);
	if (resolvedPath) return { line: fileHyperlink(resolvedPath, styled), absPath: resolvedPath };
	return { line: uriHyperlink(raw, styled) };
}

function parseSearchDisplayLineNumber(line: string): number | undefined {
	const match = SEARCH_CODE_FRAME_LINE_RE.exec(line);
	if (!match) return undefined;
	return Number.parseInt(match[1]!, 10);
}

const SEARCH_MATCH_LINE_RE = /^\s*\*\d+(?:│|[:|])/;

interface RenderedSearchLine {
	raw: string;
	styled: string;
}

function isSearchMatchLine(line: string): boolean {
	return SEARCH_MATCH_LINE_RE.test(line);
}

function isSearchHeaderLine(line: string): boolean {
	return /^#+ /.test(line);
}

const URL_HEADER_PREFIX_RE = /^#+\s+/;

function renderSearchDisplayLines(
	lines: readonly string[],
	headerBase: string | undefined,
	fileScope: string | undefined,
	uiTheme: Theme,
): RenderedSearchLine[] {
	const contexts = classifyGroupedLines(lines, headerBase, fileScope);
	// `classifyGroupedLines` can't resolve internal URLs (TUI-only), so track the
	// resolved URL target here and use it for the body lines that follow.
	let urlFile: string | undefined;
	return lines.map((line, index) => {
		const ctx = contexts[index]!;
		if (ctx.kind === "dir") {
			urlFile = undefined;
			const styled = uiTheme.fg("accent", line);
			return { raw: line, styled: ctx.headerPath ? fileHyperlink(ctx.headerPath, styled) : styled };
		}
		if (ctx.kind === "file") {
			if (ctx.isUrl) {
				const raw = line
					.replace(URL_HEADER_PREFIX_RE, "")
					.trimEnd()
					.replace(/\s+\([^)]*\)\s*$/, "");
				const linked = linkUrlLikeSearchHeader(raw, uiTheme.fg("accent", line));
				urlFile = linked.absPath;
				return { raw: line, styled: linked.line };
			}
			urlFile = undefined;
			// Root-level files keep the bright accent; nested file headers are dimmed.
			const styled = uiTheme.fg(ctx.depth === 1 ? "accent" : "dim", line);
			return { raw: line, styled: ctx.headerPath ? fileHyperlink(ctx.headerPath, styled) : styled };
		}
		const styled = uiTheme.fg("toolOutput", line);
		const lineNumber = parseSearchDisplayLineNumber(line);
		const filePath = ctx.filePath ?? urlFile;
		return {
			raw: line,
			styled: filePath && lineNumber !== undefined ? fileHyperlink(filePath, styled, { line: lineNumber }) : styled,
		};
	});
}

function compactSearchPreviewGroup(group: RenderedSearchLine[]): RenderedSearchLine[] {
	const compact = group.filter(line => isSearchHeaderLine(line.raw) || isSearchMatchLine(line.raw));
	return compact.length > 0 ? compact : group;
}

function countPreviewMatches(lines: readonly RenderedSearchLine[], hasMarkedMatches: boolean): number {
	if (hasMarkedMatches) return lines.reduce((count, line) => count + (isSearchMatchLine(line.raw) ? 1 : 0), 0);
	return lines.reduce((count, line) => count + (!isSearchHeaderLine(line.raw) && line.raw.length > 0 ? 1 : 0), 0);
}

function renderBudgetedSearchGroups(
	groups: RenderedSearchLine[][],
	maxLines: number,
	matchCount: number,
	uiTheme: Theme,
	compact: boolean,
): string[] {
	if (maxLines <= 0) return [];
	const renderedGroups = groups
		.map(group => (compact ? compactSearchPreviewGroup(group) : group))
		.filter(group => group.length > 0);
	if (renderedGroups.length === 0) return [];

	let totalLines = 0;
	let totalMarkedMatches = 0;
	let totalFallbackMatches = 0;
	for (const group of renderedGroups) {
		totalLines += group.length;
		totalMarkedMatches += countPreviewMatches(group, true);
		totalFallbackMatches += countPreviewMatches(group, false);
	}
	const hasMarkedMatches = totalMarkedMatches > 0;
	const needsSummary = totalLines > maxLines;
	const contentBudget = needsSummary ? Math.max(maxLines - 1, 0) : maxLines;
	const visibleGroups: RenderedSearchLine[][] = [];
	let visibleLineCount = 0;
	let visibleMatches = 0;
	for (const group of renderedGroups) {
		if (visibleLineCount >= contentBudget) break;
		const available = contentBudget - visibleLineCount;
		const take = Math.min(group.length, available);
		if (take <= 0) break;
		const visibleGroup = group.slice(0, take);
		visibleGroups.push(visibleGroup);
		visibleLineCount += visibleGroup.length;
		visibleMatches += countPreviewMatches(visibleGroup, hasMarkedMatches);
	}

	const totalMatches = hasMarkedMatches ? totalMarkedMatches : Math.max(matchCount, totalFallbackMatches);
	const hiddenMatches = Math.max(totalMatches - visibleMatches, 0);
	const hiddenLines = Math.max(totalLines - visibleLineCount, 0);
	const hasSummary = needsSummary && (hiddenMatches > 0 || hiddenLines > 0);
	const lines: string[] = [];
	for (let i = 0; i < visibleGroups.length; i++) {
		const group = visibleGroups[i]!;
		const isLast = !hasSummary && i === visibleGroups.length - 1;
		const prefix = `${uiTheme.fg("dim", getTreeBranch(isLast, uiTheme))} `;
		const continuePrefix = uiTheme.fg("dim", getTreeContinuePrefix(isLast, uiTheme));
		lines.push(`${prefix}${replaceTabs(group[0]!.styled)}`);
		for (let j = 1; j < group.length; j++) {
			lines.push(`${continuePrefix}${replaceTabs(group[j]!.styled)}`);
		}
	}
	if (hasSummary) {
		const hiddenLabel =
			hiddenMatches > 0 ? formatMoreItems(hiddenMatches, "match") : formatMoreItems(hiddenLines, "line");
		lines.push(`${uiTheme.fg("dim", uiTheme.tree.last)} ${uiTheme.fg("muted", hiddenLabel)}`);
	}
	return lines;
}

function grepStatusIcon(uiTheme: Theme): string {
	return uiTheme.fg("toolTitle", uiTheme.symbol("icon.search"));
}

export const grepToolRenderer = {
	inline: true,
	renderCall(args: GrepRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const paths = toPathList(args.path ?? args.paths);
		const meta: string[] = [];
		if (paths.length) meta.push(`in ${paths.join(", ")}`);
		if (args.case === false) meta.push("case:insensitive");
		if (args.gitignore === false) meta.push("gitignore:false");
		if (args.skip !== undefined && args.skip > 0) meta.push(`skip:${args.skip}`);

		const text = renderStatusLine(
			{ icon: "pending", title: "Grep", titleColor: "toolTitle", description: args.pattern || "?", meta },
			uiTheme,
		);
		return new Text(text, 1, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: GrepToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: GrepRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 1, 0);
		}

		const hasDetailedData = details?.matchCount !== undefined || details?.fileCount !== undefined;

		if (!hasDetailedData) {
			const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text;
			if (!textContent || textContent === "No matches found") {
				return new Text(formatEmptyMessage("No matches found", uiTheme), 1, 0);
			}
			const lines = textContent.split("\n").filter(line => line.trim() !== "");
			const description = args?.pattern ?? undefined;
			const header = renderStatusLine(
				{
					iconOverride: grepStatusIcon(uiTheme),
					title: "Grep",
					titleColor: "toolTitle",
					description,
					meta: [formatCount("item", lines.length)],
				},
				uiTheme,
			);
			return createCachedComponent(
				() => options.expanded,
				width => {
					const listLines = renderTreeList(
						{
							items: lines,
							expanded: options.expanded,
							maxCollapsed: COLLAPSED_TEXT_LIMIT,
							maxCollapsedLines: COLLAPSED_TEXT_LIMIT,
							itemType: "item",
							renderItem: line => uiTheme.fg("toolOutput", line),
						},
						uiTheme,
					);
					return [header, ...listLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
				},
				{ paddingX: 1 },
			);
		}

		const matchCount = details?.matchCount ?? 0;
		const fileCount = details?.fileCount ?? 0;
		const truncation = details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const truncated = Boolean(details?.truncated || truncation || limits?.columnTruncated);

		const missingPathsList = details?.missingPaths ?? [];
		const missingNote =
			missingPathsList.length > 0
				? uiTheme.fg("warning", `skipped missing: ${missingPathsList.join(", ")}`)
				: undefined;

		if (matchCount === 0) {
			const meta = ["0 matches"];
			const scopeMeta = searchScopeMeta(details);
			if (scopeMeta) meta.push(scopeMeta);
			const header = renderStatusLine(
				{ icon: "warning", title: "Grep", titleColor: "toolTitle", description: args?.pattern, meta },
				uiTheme,
			);
			const lines = [header, formatEmptyMessage("No matches found", uiTheme)];
			if (missingNote) lines.push(missingNote);
			return new Text(lines.join("\n"), 1, 0);
		}

		const summaryParts = [formatCount("match", matchCount), formatCount("file", fileCount)];
		const meta = [...summaryParts];
		const scopeMeta = searchScopeMeta(details);
		if (scopeMeta) meta.push(scopeMeta);
		if (truncated) meta.push(uiTheme.fg("warning", "truncated"));
		const description = args?.pattern ?? undefined;
		const header = renderStatusLine(
			{
				...(truncated ? { icon: "warning" as const } : { iconOverride: grepStatusIcon(uiTheme) }),
				title: "Grep",
				titleColor: "toolTitle",
				description,
				meta,
			},
			uiTheme,
		);

		const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const allLines = textContent.split("\n");
		// Resolve hyperlinks once over the whole output so a nested directory stack
		// reconstructs correctly across blank-line group boundaries.
		// Header/match display paths are cwd-relative, so resolve them against cwd
		// (falling back to searchPath for legacy results that predate `cwd`); the
		// scoped file's absolute path seeds body lines in single-file searches.
		const renderedLines = renderSearchDisplayLines(
			allLines,
			details?.cwd ?? details?.searchPath,
			details?.searchPath,
			uiTheme,
		);
		const matchGroups = groupLineIndicesByBlank(allLines).map(indices => indices.map(i => renderedLines[i]!));

		const extraLines: string[] = [];
		if (missingNote) extraLines.push(missingNote);

		return createCachedComponent(
			() => options.expanded,
			width => {
				const budget = Math.max(
					(options.expanded ? EXPANDED_TEXT_LIMIT : COLLAPSED_TEXT_LIMIT) - extraLines.length,
					0,
				);
				const matchLines = renderBudgetedSearchGroups(matchGroups, budget, matchCount, uiTheme, !options.expanded);
				return [header, ...matchLines, ...extraLines].map(l => truncateToWidth(l, width, Ellipsis.Omit));
			},
			{ paddingX: 1 },
		);
	},
	mergeCallAndResult: true,
};
