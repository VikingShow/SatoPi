/**
 * CrewTranscriptView contracts (Phase B — crew info stream overhaul):
 * - Entries render as blocks: a header row (HH:MM + round label + coloured
 *   agent tag) + wrapped body, with exactly ONE blank row between adjacent
 *   entries (mirrors the main-session transcript's block rhythm).
 * - Bodies wrap semantically: normal text breaks at word boundaries, and long
 *   tokens break only at the column bound, so no rendered content line ever
 *   exceeds the panel's inner width (and thus never re-wraps inside the frame).
 * - When the host supplies an overlay height budget (setTargetHeight), the
 *   framed panel never emits more rows than the budget, so the engine's
 *   maxHeight clamp cannot clip the bottom border.
 * - The tools toggle is gone: no [tools]/[msg-only] badge is rendered and `t`
 *   no longer changes anything.
 *
 * The view is a plain Component: render(width)/handleInput are driven directly
 * with no TUI instance (matching the swarm-sidebar test conventions).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import {
	type CrewTranscriptEntry,
	type CrewTranscriptState,
	CrewTranscriptView,
} from "@satopi/pi-coding-agent/modes/components/swarm/crew-transcript-view";
import { initTheme, theme } from "@satopi/pi-coding-agent/modes/theme/theme";
import { visibleWidth } from "@satopi/pi-tui";

const strip = (line: string): string => Bun.stripANSI(line);

/** Fixed timestamp: only HH:MM (local) is rendered, stable within a process. */
const T = 1_700_000_000_000;

function makeState(entries: CrewTranscriptEntry[]): CrewTranscriptState {
	return {
		crew: { id: "c1", name: "Test Crew", members: [], createdAt: 0 },
		topic: "Test topic",
		totalRounds: 1,
		entries,
	};
}

const newView = (entries: CrewTranscriptEntry[]): CrewTranscriptView =>
	new CrewTranscriptView(makeState(entries), theme, () => {});

/** Stripped rows of the full framed panel at a given outer width. */
const renderedAt = (view: CrewTranscriptView, width: number): string[] => view.render(width).map(strip);

/** Content row of the framed panel: a "│" border at both ends. */
const isContentRow = (line: string): boolean => line.startsWith("\u2502") && line.endsWith("\u2502");

/** Inner text of a content row ("│ " + inner + " │"), trailing frame padding dropped. */
const innerOf = (line: string): string => line.slice(2, -1).trimEnd();

describe("CrewTranscriptView transcript stream", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders two adjacent entries with exactly one blank row between them", () => {
		const view = newView([
			{ agentId: "alpha", body: "first message", timestamp: T, round: 1 },
			{ agentId: "bravo", body: "second message", timestamp: T, round: 1 },
		]);
		const lines = renderedAt(view, 60);
		const first = lines.findIndex(l => l.includes("[alpha]"));
		const second = lines.findIndex(l => l.includes("[bravo]"));
		expect(first).toBeGreaterThan(-1);
		expect(second).toBeGreaterThan(first);
		// The separator between the two blocks is exactly one blank content row.
		const between = lines.slice(first + 1, second);
		const blankRows = between.filter(l => innerOf(l).trim() === "");
		expect(blankRows).toHaveLength(1);
		// Prefix is shortened to HH:MM (no seconds) before the agent tag.
		expect(lines[first]).toMatch(/\d{2}:\d{2} \[alpha\]/);
	});

	it("keeps every content line within the inner width, breaking long tokens only at the column bound", () => {
		const longToken = "supercalifragilisticexpialidocioussupercalifragilisticexpialidocious"; // 68 chars
		const view = newView([{ agentId: "alpha", body: `${longToken} tail`, timestamp: T, round: 1 }]);
		const width = 60;
		const innerWidth = width - 4; // swarmPanel reserves border + padding (4 cols)
		const lines = renderedAt(view, width);
		const contentRows = lines.filter(isContentRow).map(innerOf);
		// The unbreakable token had to wrap onto at least one continuation row.
		expect(contentRows.length).toBeGreaterThan(1);
		for (const row of contentRows) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(innerWidth);
		}
	});

	it("wraps multi-word bodies at word boundaries, never cutting a word", () => {
		const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india"];
		const body = words.join(" ");
		const view = newView([{ agentId: "alpha", body, timestamp: T, round: 1 }]);
		const lines = renderedAt(view, 40);
		const rows = lines.filter(isContentRow).map(innerOf);
		// First body row carries the header prefix; strip everything up to the tag.
		const tagRow = rows.findIndex(r => r.includes("[alpha]"));
		expect(tagRow).toBeGreaterThan(-1);
		const first = rows[tagRow]!.slice(rows[tagRow]!.indexOf("[alpha]") + "[alpha]".length).trim();
		const rest = rows
			.slice(tagRow + 1)
			.map(r => r.trim())
			.filter(w => w.length > 0);
		const reconstructed = [first, ...rest].join(" ");
		// More than one row proves wrapping happened; the reconstruction proves
		// no word was split across rows (a hard cut would inject a space inside
		// the word and break the round-trip).
		expect(rest.length).toBeGreaterThan(0);
		expect(reconstructed).toBe(body);
	});

	it("never exceeds the host-provided target height and keeps the bottom border", () => {
		const view = newView([
			{ agentId: "alpha", body: "one two three four five six seven", timestamp: T, round: 1 },
			{ agentId: "bravo", body: "eight nine ten eleven twelve", timestamp: T, round: 1 },
		]);
		view.setTargetHeight(12);
		const lines = renderedAt(view, 60);
		expect(lines.length).toBeLessThanOrEqual(12);
		const lastNonEmpty = [...lines].reverse().find(l => l.trim() !== "");
		expect(strip(lastNonEmpty ?? "")).toMatch(/╰|└/);
		// Simulate the overlay engine's maxHeight clamp (slice to the budget):
		// the bottom border must still be the last painted row.
		const clamped = lines.slice(0, 12);
		const clampedLast = [...clamped].reverse().find(l => l.trim() !== "");
		expect(strip(clampedLast ?? "")).toMatch(/╰|└/);
	});

	it("no longer toggles anything with t: no [tools]/[msg-only] badge, render stays stable", () => {
		const view = newView([{ agentId: "alpha", body: "hello crew", timestamp: T, round: 1 }]);
		const before = renderedAt(view, 60);
		const text = before.join("\n");
		expect(text).not.toContain("[msg-only]");
		expect(text).not.toContain("[tools]");
		expect(text).not.toContain("t:tools");
		view.handleInput("t");
		view.handleInput("T");
		const after = renderedAt(view, 60);
		expect(after).toEqual(before);
	});

	it("no longer renders any converged status (B3 field removal)", () => {
		const view = newView([{ agentId: "alpha", body: "hello crew", timestamp: T, round: 1 }]);
		const text = renderedAt(view, 60).join("\n");
		expect(text).not.toMatch(/converged/i);
	});
});
