/**
 * Unit tests for SatoPi TUI theme, splash screen, and colour helpers.
 *
 * Tests:
 *   - sato colour functions produce chalk output
 *   - PHASE_DISPLAY coverage for every Chapter
 *   - PI_LOGO_ASCII uniformity
 *   - renderSplash output validation
 */

import { describe, expect, it } from "bun:test";
import chalk from "chalk";
import type { Chapter } from "../core/state";
import { renderSplash } from "../../modes/components/swarm/splash";
import { PHASE_DISPLAY, PI_LOGO_ASCII, sato } from "../../modes/components/swarm/theme";

// Force chalk level for deterministic ANSI output in test environments.
chalk.level = 1;

// ============================================================================
// sato colour helpers
// ============================================================================

describe("sato colour helpers", () => {
	it("sato.success wraps text in ANSI escape codes", () => {
		const result = sato.success("OK");
		expect(result).toContain("\x1b[");
		expect(result).toContain("OK");
		expect(result).toMatch(/\x1b\[0m$/);
	});

	it("sato.error wraps text in ANSI escape codes", () => {
		const result = sato.error("FAIL");
		expect(result).toContain("\x1b[");
		expect(result).toContain("FAIL");
	});

	it("sato.warning wraps text", () => {
		const result = sato.warning("WARN");
		expect(result).toContain("\x1b[");
		expect(result).toContain("WARN");
	});

	it("sato.muted wraps text", () => {
		const result = sato.muted("quiet");
		expect(result).toContain("\x1b[");
		expect(result).toContain("quiet");
	});

	it("sato.dim wraps text", () => {
		const result = sato.dim("faded");
		expect(result).toContain("\x1b[");
		expect(result).toContain("faded");
	});

	it("sato.bold wraps text in bold", () => {
		const result = sato.bold("loud");
		expect(result).toContain("loud");
		expect(result).toContain("\x1b[1m");
	});

	it("sato.amber wraps text", () => {
		const result = sato.amber("gold");
		expect(result).toContain("gold");
		expect(result).toContain("\x1b[");
	});

	it("sato.info wraps text", () => {
		const result = sato.info("info");
		expect(result).toContain("info");
	});

	it("sato.purple wraps text", () => {
		const result = sato.purple("purple");
		expect(result).toContain("purple");
	});

	it("sato.orange wraps text", () => {
		const result = sato.orange("orange");
		expect(result).toContain("orange");
	});

	it("handles empty string", () => {
		const result = sato.success("");
		expect(result).toMatch(/\x1b\[0m$/);
	});
});

// ============================================================================
// PHASE_DISPLAY
// ============================================================================

describe("PHASE_DISPLAY", () => {
	const ALL_CHAPTERS: Chapter[] = [
		"idle", "script", "script-debate", "script-confirm",
		"stage", "paused", "blocked", "curtain",
	];

	it("has an entry for every Chapter value", () => {
		for (const chapter of ALL_CHAPTERS) {
			const entry = PHASE_DISPLAY[chapter];
			expect(entry).toBeDefined();
			expect(entry.icon).toBeString();
			expect(entry.icon.length).toBeGreaterThan(0);
			expect(entry.label).toBeString();
			expect(entry.label.length).toBeGreaterThan(0);
		}
	});

	it("has exactly 8 entries", () => {
		expect(Object.keys(PHASE_DISPLAY).length).toBe(8);
	});

	it("every phase has a non-empty icon", () => {
		for (const chapter of ALL_CHAPTERS) {
			expect(PHASE_DISPLAY[chapter].icon).toBeString();
			expect(PHASE_DISPLAY[chapter].icon.length).toBeGreaterThan(0);
		}
	});

	it("every phase has a non-empty label", () => {
		for (const chapter of ALL_CHAPTERS) {
			expect(PHASE_DISPLAY[chapter].label).toBeString();
			expect(PHASE_DISPLAY[chapter].label.length).toBeGreaterThan(0);
		}
	});
});

// ============================================================================
// PI_LOGO_ASCII
// ============================================================================

describe("PI_LOGO_ASCII", () => {
	it("has rows", () => {
		expect(PI_LOGO_ASCII.length).toBeGreaterThan(0);
	});

	it("each row has reasonable width", () => {
		for (const row of PI_LOGO_ASCII) {
			expect(row.length).toBeGreaterThanOrEqual(40);
			expect(row.length).toBeLessThanOrEqual(46);
		}
	});

	it("contains Pi logo block characters", () => {
		const joined = PI_LOGO_ASCII.join("");
		expect(joined).toContain("●");
		expect(joined).toContain("█");
		expect(joined).toContain("▄");
	});
});

// ============================================================================
// renderSplash
// ============================================================================

describe("renderSplash", () => {
	it("returns non-empty lines for default width", () => {
		const lines = renderSplash();
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(line).toBeString();
			const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
			expect(plain.length).toBeGreaterThan(0);
		}
	});

	it("returns non-empty lines for minimum width", () => {
		const lines = renderSplash(50);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
			expect(plain.length).toBeGreaterThan(0);
		}
	});

	it("clamps width to minimum 60", () => {
		const lines = renderSplash(30);
		const firstLine = lines[0];
		const plain = firstLine.replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain.length).toBeGreaterThanOrEqual(60);
	});

	it("has correct number of lines", () => {
		const lines = renderSplash();
		expect(lines.length).toBe(17);
	});

	it("top line starts with ╔ and ends with ╗", () => {
		const lines = renderSplash();
		const plain = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain.startsWith("╔")).toBe(true);
		expect(plain.endsWith("╗")).toBe(true);
	});

	it("bottom border line starts with ╚ and ends with ╝", () => {
		const lines = renderSplash();
		const plain = lines[lines.length - 2].replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain.startsWith("╚")).toBe(true);
		expect(plain.endsWith("╝")).toBe(true);
	});

	it("contains SatoPi brand text", () => {
		const lines = renderSplash();
		const joined = lines.join("\n");
		const plain = joined.replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain("S a t o P i");
	});

	it("includes tagline below the box", () => {
		const lines = renderSplash();
		const lastLine = lines[lines.length - 1];
		const plain = lastLine.replace(/\x1b\[[0-9;]*m/g, "");
		expect(plain).toContain("Satori a team of Pi");
		expect(plain).toContain("v0.0.1");
	});
});
