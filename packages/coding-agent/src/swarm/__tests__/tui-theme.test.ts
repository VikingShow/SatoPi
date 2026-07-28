/**
 * Unit tests for swarm splash screen (post-unification).
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { renderSplash } from "../../modes/components/swarm/splash";
import { getThemeByName, setThemeInstance, type Theme } from "../../modes/theme/theme";

let theme: Theme;

beforeAll(async () => {
	const loaded = await getThemeByName("satopi");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
	theme = loaded;
});

describe("renderSplash", () => {
	it("returns non-empty output", () => {
		const lines = renderSplash(80, theme);
		expect(lines.length).toBeGreaterThan(0);
	});

	it("top border uses theme box chars", () => {
		const lines = renderSplash(80, theme);
		expect(lines[0]).toContain(theme.boxRound.topLeft);
	});

	it("contains brand text", () => {
		const lines = renderSplash(80, theme);
		const text = lines.join("\n");
		expect(text).toContain("S a t o P i");
	});

	it("contains PI_LOGO content", () => {
		const lines = renderSplash(80, theme);
		const text = lines.join("\n");
		expect(text).toContain("π");
	});

	it("adapts to narrow width", () => {
		const lines = renderSplash(40, theme);
		expect(lines.length).toBeGreaterThan(0);
	});
});
