/**
 * profile.ts — pure argument parsing / rendering helpers for the `/profile`
 * slash command (Phase C of the crew-discovery TUI plan).
 *
 * Kept free of side effects so the command handler stays thin and the table
 * rendering + flag parsing are directly unit-testable without a registry.
 */

import type { AgentProfile } from "../../agent/agent-profile";

export const PROFILE_USAGE =
	"Usage: /profile [list | create <name> [--archetype <type>] [--domains a,b] | delete <profileId>]";

export interface ProfileCreateArgs {
	/** First non-flag token; undefined when the invocation has no name. */
	name?: string;
	/** Value of `--archetype <type>`, if present. */
	archetype?: string;
	/** Values of `--domains a,b` split and trimmed, if present. */
	domains: string[];
}

/**
 * Parse `/profile create` args: `<name> [--archetype <t>] [--domains a,b]`.
 * Unknown tokens are ignored; a flag without a value is skipped. `name` is a
 * single token (the plan's grammar), so multi-word names must be quoted-free
 * slugs — the derived profileId comes from `deriveProfileId` anyway.
 */
export function parseProfileCreateArgs(rest: string): ProfileCreateArgs {
	const tokens = rest.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { domains: [] };

	const args: ProfileCreateArgs = { domains: [] };
	let i = 0;
	if (!tokens[0]!.startsWith("-")) {
		args.name = tokens[0];
		i = 1;
	}
	while (i < tokens.length) {
		const token = tokens[i]!;
		const value = tokens[i + 1];
		if (token === "--archetype" && value && !value.startsWith("-")) {
			args.archetype = value;
			i += 2;
			continue;
		}
		if (token === "--domains" && value && !value.startsWith("-")) {
			args.domains.push(...value.split(",").map(s => s.trim()).filter(Boolean));
			i += 2;
			continue;
		}
		i += 1;
	}
	return args;
}

/**
 * Render a text table of profiles: profileId / name / archetype / credit.
 * Column widths are derived from the content so the table stays readable for
 * both short builtin ids and longer user-created ones.
 */
export function renderProfileTable(profiles: readonly AgentProfile[]): string {
	if (profiles.length === 0) return "No agent profiles found.";

	const header = ["profileId", "name", "archetype", "credit"];
	const rows = profiles.map(p => [p.profileId, p.identity.name, p.identity.archetype, String(p.credit.score)]);
	const widths = header.map((h, col) => Math.max(h.length, ...rows.map(r => r[col]!.length)));

	const line = (cells: readonly string[]): string =>
		cells.map((cell, col) => cell.padEnd(widths[col]!)).join("  ").trimEnd();

	const sorted = [...rows].sort((a, b) => Number(b[3]) - Number(a[3]));
	return [line(header), line(widths.map(w => "-".repeat(w))), ...sorted.map(line)].join("\n");
}
