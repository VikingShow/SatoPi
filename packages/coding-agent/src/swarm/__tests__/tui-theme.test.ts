/**
 * Unit tests for SatoPi TUI theme, splash screen, and ANSI helpers.
 *
 * Tests:
 *   - SATOPI_COLORS completeness
 *   - PHASE_DISPLAY coverage for every Chapter
 *   - ansiFg / ansiBold / ansiDim correctness
 *   - PI_LOGO_ASCII uniformity
 *   - renderSplash output validation
 */

import { describe, expect, it } from "bun:test";
import { SATOPI_COLORS, PHASE_DISPLAY, PI_LOGO_ASCII, ansiFg, ansiBold, ansiDim } from "../tui/theme";
import { renderSplash } from "../tui/splash";
import type { Chapter } from "../core/state";

// ============================================================================
// SATOPI_COLORS
// ============================================================================

describe("SATOPI_COLORS", () => {
  it("defines all expected color keys", () => {
    const keys = Object.keys(SATOPI_COLORS);
    expect(keys).toContain("primary");
    expect(keys).toContain("primaryBg");
    expect(keys).toContain("background");
    expect(keys).toContain("surface");
    expect(keys).toContain("surface2");
    expect(keys).toContain("text");
    expect(keys).toContain("muted");
    expect(keys).toContain("border");
    expect(keys).toContain("success");
    expect(keys).toContain("warning");
    expect(keys).toContain("danger");
    expect(keys).toContain("info");
    expect(keys).toContain("purple");
    expect(keys).toContain("logoOrange");
    expect(keys).toContain("logoWhite");
    expect(keys).toContain("logoDark");
    expect(keys.length).toBe(16);
  });

  it("each color has hex, ansi256, and name", () => {
    for (const [key, value] of Object.entries(SATOPI_COLORS)) {
      expect(value.hex).toBeString();
      expect(value.hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(value.ansi256).toBeNumber();
      expect(value.ansi256).toBeWithin(0, 256);
      expect(value.name).toBeString();
    }
  });

  it("primary color hex matches brand amber", () => {
    expect(SATOPI_COLORS.primary.hex).toBe("#F59E0B");
    expect(SATOPI_COLORS.primary.ansi256).toBe(214);
  });
});

// ============================================================================
// PHASE_DISPLAY
// ============================================================================

describe("PHASE_DISPLAY", () => {
  const ALL_CHAPTERS: Chapter[] = [
    "idle",
    "script",
    "script-debate",
    "script-confirm",
    "stage",
    "paused",
    "blocked",
    "curtain",
  ];

  it("has an entry for every Chapter value", () => {
    for (const chapter of ALL_CHAPTERS) {
      const entry = PHASE_DISPLAY[chapter];
      expect(entry).toBeDefined();
      expect(entry.color).toBeDefined();
      expect(entry.icon).toBeString();
      expect(entry.icon.length).toBeGreaterThan(0);
      expect(entry.label).toBeString();
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it("has exactly 8 entries (no extra keys)", () => {
    expect(Object.keys(PHASE_DISPLAY).length).toBe(8);
  });

  it("idle phase uses muted color", () => {
    expect(PHASE_DISPLAY.idle.color).toBe(SATOPI_COLORS.muted);
  });

  it("stage phase uses primary color", () => {
    expect(PHASE_DISPLAY.stage.color).toBe(SATOPI_COLORS.primary);
  });

  it("blocked phase uses danger color", () => {
    expect(PHASE_DISPLAY.blocked.color).toBe(SATOPI_COLORS.danger);
  });

  it("script phase uses info color", () => {
    expect(PHASE_DISPLAY.script.color).toBe(SATOPI_COLORS.info);
  });
});

// ============================================================================
// ANSI helpers
// ============================================================================

describe("ansiFg", () => {
  it("produces valid SGR foreground escape sequence", () => {
    const result = ansiFg(214, "hello");
    // Should start with ESC[38;5;214m and end with ESC[0m
    expect(result).toMatch(/^\x1b\[38;5;214m/);
    expect(result).toEndWith("\x1b[0m");
    expect(result).toContain("hello");
  });

  it("wraps text with color reset", () => {
    const result = ansiFg(41, "OK");
    expect(result).toBe("\x1b[38;5;41mOK\x1b[0m");
  });

  it("handles empty string", () => {
    const result = ansiFg(0, "");
    expect(result).toBe("\x1b[38;5;0m\x1b[0m");
  });
});

describe("ansiBold", () => {
  it("produces bold SGR escape sequence", () => {
    const result = ansiBold("bold text");
    expect(result).toMatch(/^\x1b\[1m/);
    expect(result).toEndWith("\x1b[0m");
    expect(result).toContain("bold text");
  });
});

describe("ansiDim", () => {
  it("produces dim SGR escape sequence", () => {
    const result = ansiDim("dim text");
    expect(result).toMatch(/^\x1b\[2m/);
    expect(result).toEndWith("\x1b[0m");
    expect(result).toContain("dim text");
  });
});

// ============================================================================
// PI_LOGO_ASCII
// ============================================================================

describe("PI_LOGO_ASCII", () => {
  it("has rows", () => {
    expect(PI_LOGO_ASCII.length).toBeGreaterThan(0);
  });

  it("each row has reasonable width for a 60-column terminal", () => {
    for (const row of PI_LOGO_ASCII) {
      // Rows vary due to Unicode double-width chars (●) and block elements (▄, █).
      // Actual widths: 41–44 code units. All fit within the splash inner area.
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
  it("returns non-empty lines for default width (62)", () => {
    const lines = renderSplash();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toBeString();
      // Strip ANSI escapes to check for meaningful content
      const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
      expect(plain.length).toBeGreaterThan(0);
    }
  });

  it("returns non-empty lines for minimum width (50)", () => {
    const lines = renderSplash(50);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
      expect(plain.length).toBeGreaterThan(0);
    }
  });

  it("clamps width to minimum 50", () => {
    const lines = renderSplash(30);
    const firstLine = lines[0];
    const plain = firstLine.replace(/\x1b\[[0-9;]*m/g, "");
    // Border should be at least 50 cols wide (inner width >= 48 + 2 corners)
    expect(plain.length).toBeGreaterThanOrEqual(50);
  });

  it("returns more lines than just borders", () => {
    const lines = renderSplash();
    // top border + empty + "S a t o P i" header + empty + logo (10) + empty + bottom border + tagline = 17
    expect(lines.length).toBe(17);
  });

  it("top line is a golden border with box-drawing corners", () => {
    const lines = renderSplash();
    const plain = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain.startsWith("╔")).toBe(true);
    expect(plain.endsWith("╗")).toBe(true);
  });

  it("bottom line is a golden border with box-drawing corners", () => {
    const lines = renderSplash();
    const plain = lines[lines.length - 2].replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain.startsWith("╚")).toBe(true);
    expect(plain.endsWith("╝")).toBe(true);
  });

  it("contains SatoPi brand text in the content area", () => {
    const lines = renderSplash();
    const joined = lines.join("\n");
    // Strip ANSI escapes for plaintext check
    const plain = joined.replace(/\x1b\[[0-9;]*m/g, "");
    // SatoPi brand splash uses spaced text "S a t o P i" (stylized header)
    expect(plain).toContain("S a t o P i");
  });

  it("golden border uses primary amber ANSI code", () => {
    const lines = renderSplash();
    expect(lines[0]).toContain(`\x1b[38;5;${SATOPI_COLORS.primary.ansi256}m`);
  });

  it("includes tagline below the box", () => {
    const lines = renderSplash();
    const lastLine = lines[lines.length - 1];
    const plain = lastLine.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toContain("Satori a team of Pi");
    expect(plain).toContain("v0.0.1");
  });
});
