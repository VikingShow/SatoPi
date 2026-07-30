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

			const items: AutocompleteItem[] = refs
				.filter(r => partial === "" || r.displayName.toLowerCase().includes(partial))
				.slice(0, 10)
				.map(r => ({
					value: r.id,
					id: r.id,
					label: `@${r.displayName}`,
					description: r.role ?? r.kind,
				}));

			if (items.length === 0) return null;
			return { items, prefix: `@${partial}` };
		},

		applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, _prefix: string) {
			const text = lines[cursorLine] ?? "";
			const mention = findAgentMentionPrefix(text, cursorCol);
			if (!mention) return { lines, cursorLine, cursorCol };

			const label = item.label.startsWith("@") ? item.label.slice(1) : item.label;
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
