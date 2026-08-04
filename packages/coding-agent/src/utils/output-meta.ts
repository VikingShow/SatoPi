/**
 * utils/output-meta.ts — Tool output metadata types and notice formatters.
 *
 * Extracted from `tools/output-meta.ts` so the `session/` layer (messages.ts)
 * can consume `OutputMeta` + `formatOutputNotice` without importing `tools/`,
 * breaking the session↔tools directory-level dependency cycle.
 */

import { formatBytes } from "@satopi/pi-utils";
import { formatGroupedDiagnosticMessages } from "../lsp/utils";

/**
 * Truncation metadata for the output notice.
 */
export interface TruncationMeta {
	direction: "head" | "tail" | "middle";
	truncatedBy: "lines" | "bytes" | "middle";
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	maxBytes?: number;
	/** Line range shown (1-indexed, inclusive). Omitted for middle elision. */
	shownRange?: { start: number; end: number };
	/** Head/tail line ranges shown when direction === "middle". */
	headRange?: { start: number; end: number };
	tailRange?: { start: number; end: number };
	/** Bytes elided from the middle. */
	elidedBytes?: number;
	/** Lines elided from the middle. */
	elidedLines?: number;
	/** Artifact ID if full output was saved */
	artifactId?: string;
	/** Next offset for pagination (head truncation only) */
	nextOffset?: number;
}

/**
 * Source resolution info for the output.
 */
export type SourceMeta =
	| { type: "path"; value: string }
	| { type: "url"; value: string }
	| { type: "internal"; value: string };

/**
 * LSP diagnostic info (for edit/write tools).
 */
export interface DiagnosticMeta {
	summary: string;
	messages: string[];
}

/**
 * Limit-specific notices.
 */
export interface LimitsMeta {
	matchLimit?: { reached: number; suggestion: number };
	resultLimit?: { reached: number; suggestion: number };
	headLimit?: { reached: number; suggestion: number };
	columnTruncated?: { maxColumn: number };
}

/**
 * Structured metadata for tool outputs.
 */
export interface OutputMeta {
	truncation?: TruncationMeta;
	source?: SourceMeta;
	diagnostics?: DiagnosticMeta;
	limits?: LimitsMeta;
}

/**
 * Format a reference to the artifact holding the full output.
 */
export function formatFullOutputReference(artifactId: string): string {
	return `Read artifact://${artifactId} for full output`;
}

/**
 * Format a plain-text truncation notice from TruncationMeta.
 */
export function formatTruncationMetaNotice(truncation: TruncationMeta): string {
	let notice: string;

	if (truncation.direction === "middle") {
		const head = truncation.headRange;
		const tail = truncation.tailRange;
		const totalLines = truncation.totalLines;
		const elidedBytes = truncation.elidedBytes ?? Math.max(0, truncation.totalBytes - truncation.outputBytes);
		const elidedLines = truncation.elidedLines ?? Math.max(0, totalLines - truncation.outputLines);
		const headPart = head ? `lines ${head.start}-${head.end}` : "";
		const tailPart = tail ? `${tail.start}-${tail.end}` : "";
		if (headPart && tailPart) {
			notice = `Showing ${headPart} and ${tailPart} of ${totalLines}; ${elidedLines.toLocaleString()} middle line${elidedLines === 1 ? "" : "s"} (${formatBytes(elidedBytes)}) elided`;
		} else {
			notice = `Showing ${truncation.outputLines} of ${totalLines} lines; middle elided`;
		}
		if (truncation.artifactId != null) {
			notice += `. ${formatFullOutputReference(truncation.artifactId)}`;
		}
		return notice;
	}

	const range = truncation.shownRange;
	if (range && range.end >= range.start) {
		notice = `Showing lines ${range.start}-${range.end} of ${truncation.totalLines}`;
	} else {
		notice = `Showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
	}

	if (truncation.truncatedBy === "bytes") {
		const maxBytes = truncation.maxBytes ?? truncation.outputBytes;
		notice += ` (${formatBytes(maxBytes)} limit)`;
	}

	if (truncation.nextOffset != null) {
		notice += `. Use :${truncation.nextOffset} to continue`;
	}

	if (truncation.artifactId != null) {
		notice += `. ${formatFullOutputReference(truncation.artifactId)}`;
	}

	return notice;
}

/**
 * Format notices from OutputMeta for LLM consumption.
 * Returns empty string if no notices needed.
 */
export function formatOutputNotice(meta: OutputMeta | undefined): string {
	if (!meta) return "";

	const parts: string[] = [];

	// Truncation notice
	if (meta.truncation) {
		parts.push(formatTruncationMetaNotice(meta.truncation));
	}

	// Limit notices
	if (meta.limits?.matchLimit) {
		const l = meta.limits.matchLimit;
		parts.push(`${l.reached} matches limit reached. Use limit=${l.suggestion} for more`);
	}
	if (meta.limits?.resultLimit) {
		const l = meta.limits.resultLimit;
		parts.push(`${l.reached} results limit reached. Use limit=${l.suggestion} for more`);
	}
	if (meta.limits?.headLimit) {
		const l = meta.limits.headLimit;
		parts.push(`${l.reached} results limit reached. Use limit=${l.suggestion} for more`);
	}
	if (meta.limits?.columnTruncated) {
		parts.push(`Some lines truncated to ${meta.limits.columnTruncated.maxColumn} chars`);
	}

	// Diagnostics
	let diagnosticsNotice = "";
	if (meta.diagnostics && meta.diagnostics.messages.length > 0) {
		const d = meta.diagnostics;
		diagnosticsNotice = `\n\nLSP Diagnostics (${d.summary}):\n${formatGroupedDiagnosticMessages(d.messages)}`;
	}

	const notice = parts.length ? `\n\n[${parts.join(". ")}]` : "";
	return notice + diagnosticsNotice;
}
