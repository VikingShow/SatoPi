/**
 * mention-parser.ts — Parses @mentions from user input for Crew messaging.
 *
 * Used by SwarmModeController to split user input into directed messages
 * (per-agent) and a broadcast portion.
 *
 * Rules:
 * - `@agentId` or `@displayName` matches against crew member IDs/names
 * - Text before the first @mention or between mentions is broadcast
 * - @mentions in code blocks (`backticks`) are NOT parsed as mentions
 * - Mentions are case-insensitive for matching but preserve original case
 */

import type { AgentRef } from "../registry/agent-registry";

// ============================================================================
// Types
// ============================================================================

export interface ParsedMention {
	/** Resolved agent ID. */
	agentId: string;
	/** The text following the @mention, up to the next @mention or end. */
	text: string;
}

export interface ParsedInput {
	/** Messages directed at specific agents. */
	mentions: ParsedMention[];
	/** Message content not directed at any specific agent (broadcast to all). */
	broadcast: string;
}

// ============================================================================
// Parser
// ============================================================================

/** Match `@identifier` where identifier is alphanumeric + hyphens + underscores. */
const MENTION_RE = /@([a-zA-Z0-9_-]+)/g;

/**
 * Parse @mentions from user input. Text before the first @mention is broadcast;
 * each @mention captures all text until the next @mention (or end of string).
 *
 * @param text - Raw user input from the TUI editor
 * @param resolveAgent - Function that resolves a mention string to an agent ID.
 *   Receives the raw mention text (without @). Returns the agent ID or null if
 *   no matching agent is found in the current crew.
 */
export function parseMentions(
	text: string,
	resolveAgent: (mention: string) => string | null,
): ParsedInput {
	// Strip code blocks so @ inside backticks aren't parsed
	const cleanText = stripCodeBlocks(text);

	const mentions: ParsedMention[] = [];
	const matchPositions: Array<{ index: number; agentId: string; rawMention: string }> = [];

	// Find all valid @mentions using matchAll (no assignment-in-expression)
	const flags = `g${MENTION_RE.ignoreCase ? "i" : ""}`;
	const re = new RegExp(MENTION_RE.source, flags);
	for (const execMatch of cleanText.matchAll(re)) {
		const rawMention = execMatch[1];
		if (execMatch.index === undefined) continue;
		const agentId = resolveAgent(rawMention);
		if (agentId) {
			matchPositions.push({
				index: execMatch.index,
				agentId,
				rawMention,
			});
		}
	}

	if (matchPositions.length === 0) {
		return { mentions: [], broadcast: text.trim() };
	}

	// Extract broadcast text before the first mention
	const firstIdx = matchPositions[0].index;
	const broadcast = text.slice(0, firstIdx).trim();

	// Extract per-mention text segments
	for (let i = 0; i < matchPositions.length; i++) {
		const current = matchPositions[i];
		const searchStart = current.index;
		const mentionStart = text.indexOf(`@${current.rawMention}`, searchStart);
		if (mentionStart === -1) continue;

		const contentStart = mentionStart + current.rawMention.length + 1;

		// Content ends at next mention start, or end of string
		const nextMatch = matchPositions[i + 1];
		const contentEnd = nextMatch
			? text.indexOf(`@${nextMatch.rawMention}`, mentionStart + 1)
			: text.length;

		const mentionText = text.slice(contentStart, contentEnd === -1 ? text.length : contentEnd).trim();

		mentions.push({
			agentId: current.agentId,
			text: mentionText,
		});
	}

	return { mentions, broadcast };

}

// ============================================================================
// Resolution helpers
// ============================================================================

/**
 * Build a mention resolver that matches against crew member IDs and display names.
 * Matching is case-insensitive. Returns null for non-member mentions.
 */
export function createCrewMentionResolver(
	memberIds: Set<string>,
	agentRefs: Map<string, AgentRef>,
): (mention: string) => string | null {
	return (mention: string): string | null => {
		const lower = mention.toLowerCase();

		// 1. Exact ID match
		if (memberIds.has(mention)) return mention;
		if (memberIds.has(lower)) return lower;

		// 2. Case-insensitive search by displayName
		for (const [id, ref] of agentRefs) {
			if (ref.displayName.toLowerCase() === lower) return id;
		}

		// 3. Partial match (prefix) — only if unambiguous
		const matches: string[] = [];
		for (const id of memberIds) {
			if (id.toLowerCase().startsWith(lower)) matches.push(id);
		}
		if (matches.length === 1) return matches[0];

		// Also try displayName prefix
		for (const [id, ref] of agentRefs) {
			if (ref.displayName.toLowerCase().startsWith(lower)) {
				if (!matches.includes(id)) matches.push(id);
			}
		}
		if (matches.length === 1) return matches[0];

		return null; // no match or ambiguous
	};
}

// ============================================================================
// Helpers
// ============================================================================

/** Strip inline code spans and fenced code blocks so @ inside them aren't parsed. */
function stripCodeBlocks(text: string): string {
	// Strip fenced code blocks (``` ... ```)
	let result = text.replace(/```[\s\S]*?```/g, m => " ".repeat(m.length));

	// Strip inline code spans (`...`)
	result = result.replace(/`[^`]+`/g, m => " ".repeat(m.length));

	return result;
}
