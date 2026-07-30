import type { AutocompleteItem, AutocompleteProvider } from "@satopi/pi-tui";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";

/** Prefix that triggers agent mention autocomplete: "@" at word boundary. */
function findAgentMentionPrefix(text: string, cursorCol: number): { start: number; partial: string } | null {
	const before = text.slice(0, cursorCol);
	const atIdx = before.lastIndexOf("@");
	if (atIdx === -1) return null;
	// Must be at word boundary (start of line, after space, or after newline)
	if (atIdx > 0) {
		const prev = before[atIdx - 1];
		if (prev !== " " && prev !== "\n" && prev !== "\t") return null;
	}
	return { start: atIdx, partial: before.slice(atIdx + 1) };
}

export function createAgentMentionAutocompleteProvider(): AutocompleteProvider {
	return {
		async getSuggestions(lines: string[], cursorLine: number, cursorCol: number) {
			const text = lines[cursorLine] ?? "";
			const mention = findAgentMentionPrefix(text, cursorCol);
			if (!mention) return null;

			const partial = mention.partial.toLowerCase();
			const refs = AgentRegistry.global()
				.list()
				.filter(r => r.kind !== "advisor" && r.id !== MAIN_AGENT_ID);

			const items: AutocompleteItem[] = [];

			// @all special item — always first when partial matches
			if (partial === "" || "all".includes(partial)) {
			items.push({
				value: "__all__",
				label: "@all",
				description: "Mention all visible agents",
			});
			}

			// Agent-specific matches
			items.push(...refs
				.filter(r => partial === "" || r.displayName.toLowerCase().includes(partial))
				.slice(0, 10)
				.map(r => ({
					value: r.id,
					label: `@${r.displayName}`,
					description: r.role ?? r.kind,
				})));

			if (items.length === 0) return null;
			return { items, prefix: `@${partial}` };
		},

		applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, _prefix: string) {
			const text = lines[cursorLine] ?? "";
			const mention = findAgentMentionPrefix(text, cursorCol);
			if (!mention) return { lines, cursorLine, cursorCol };

			const label = item.value === "__all__" ? "all" : (item.label.startsWith("@") ? item.label.slice(1) : item.label);
			const before = text.slice(0, mention.start);
			const after = text.slice(cursorCol);
			const newLine = `${before}@${label} ${after}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: mention.start + label.length + 2, // @name + space
			};
		},
	};
}

/** Result of parsing @mentions from user text. */
export interface ParsedMentions {
	/** Agent IDs mentioned (excluding @all). */
	agentIds: string[];
	/** Whether @all was present. */
	allMentioned: boolean;
	/** The text with @mention tokens stripped. */
	cleanText: string;
}

/**
 * Parse @mention tokens from user text.
 * Recognizes @agentName (matching registry display names) and @all.
 * Strips the @tokens from the returned clean text.
 */
export function parseMentions(text: string): ParsedMentions {
	const registry = AgentRegistry.global();
	const visible = registry.list().filter(r => r.kind !== "advisor");
	const nameToId = new Map<string, string>();
	for (const ref of visible) {
		nameToId.set(ref.displayName.toLowerCase(), ref.id);
	}

	const agentIds: string[] = [];
	let allMentioned = false;

	// Match @word at word boundaries
	const mentionRe = /(?:^|\s)@([a-zA-Z0-9_-]+)/g;
	let cleanText = text;
	let match: RegExpExecArray | null;
	while ((match = mentionRe.exec(text)) !== null) {
		const name = match[1].toLowerCase();
		if (name === "all") {
			allMentioned = true;
			// Remove the @all token
			cleanText = cleanText.replace(match[0], match[0].startsWith(" ") ? "" : "");
		} else {
			const id = nameToId.get(name);
			if (id && !agentIds.includes(id)) {
				agentIds.push(id);
				cleanText = cleanText.replace(match[0], match[0].startsWith(" ") ? "" : "");
			}
		}
	}

	return { agentIds, allMentioned, cleanText: cleanText.trim() };
}

/**
 * Resolve mention targets to concrete agent IDs.
 * If @all was mentioned, returns all visible agent IDs.
 */
export function resolveMentionTargets(mentions: ParsedMentions): string[] {
	if (mentions.allMentioned) {
		return AgentRegistry.global()
			.list()
			.filter(r => r.kind !== "advisor")
			.map(r => r.id);
	}
	return mentions.agentIds;
}
