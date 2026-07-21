import { describe, it, expect } from "bun:test";
import {
	extractRoundSummary,
	parseNomination,
	jaccardSimilarity,
	findingsSimilarity,
	parseRoundSummaryJson,
} from "../convergence";

describe("jaccardSimilarity", () => {
	it("is 1 for two empty sets", () => {
		expect(jaccardSimilarity([], [])).toBe(1);
	});
	it("is 1 for identical sets", () => {
		expect(jaccardSimilarity(["a", "b"], ["b", "a"])).toBe(1);
	});
	it("is 0 for disjoint sets", () => {
		expect(jaccardSimilarity(["a"], ["b"])).toBe(0);
	});
	it("computes partial overlap", () => {
		// {a,b,c} vs {b,c,d} → intersection 2, union 4 → 0.5
		expect(jaccardSimilarity(["a", "b", "c"], ["b", "c", "d"])).toBe(0.5);
	});
});

describe("findingsSimilarity", () => {
	it("tokenizes, lowercases and ignores short tokens", () => {
		const s = findingsSimilarity(
			["Missing input validation"],
			["missing INPUT validation"],
		);
		expect(s).toBe(1);
	});
	it("detects divergent findings", () => {
		const s = findingsSimilarity(["auth bug in login"], ["performance regression"]);
		expect(s).toBeLessThan(0.2);
	});
});

describe("extractRoundSummary", () => {
	it("extracts the Round Summary section", () => {
		const out = "intro\n## Round Summary\nWe fixed auth.\n## Next\nmore";
		expect(extractRoundSummary(out)).toBe("We fixed auth.");
	});
	it("falls back to the first 2000 chars when absent", () => {
		const out = "no summary section here";
		expect(extractRoundSummary(out)).toBe(out);
	});
});

describe("parseNomination", () => {
	it("parses a nominated worker", () => {
		const out = "## Nomination\nnominated: worker-3\nreason: expertise";
		expect(parseNomination(out)).toEqual({ nominator: "", nominee: "worker-3" });
	});
	it("returns null without a nomination section", () => {
		expect(parseNomination("no nomination")).toBeNull();
	});
	it("returns null when the section lacks a nominated line", () => {
		expect(parseNomination("## Nomination\nreason: none")).toBeNull();
	});
});

describe("parseRoundSummaryJson", () => {
	it("parses a valid JSON round summary block", () => {
		const out = [
			"## Round Summary",
			"```json",
			JSON.stringify({ round: 2, reviewer: "worker-1", convergence_opinion: "converging" }),
			"```",
		].join("\n");
		const parsed = parseRoundSummaryJson(out);
		expect(parsed).not.toBeNull();
		expect(parsed!.round).toBe(2);
		expect(parsed!.convergence_opinion).toBe("converging");
	});
	it("returns null when no json block present", () => {
		expect(parseRoundSummaryJson("## Round Summary\nplain text")).toBeNull();
	});
	it("returns null on malformed json", () => {
		expect(parseRoundSummaryJson("```json\n{not valid}\n```")).toBeNull();
	});
	it("returns null when required fields are missing", () => {
		const out = "```json\n" + JSON.stringify({ reviewer: "x" }) + "\n```";
		expect(parseRoundSummaryJson(out)).toBeNull();
	});
});
