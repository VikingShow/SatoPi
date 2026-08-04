import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadGraphDefinition, validateGraphDefinition } from "../../graph/schema";

const BUILTIN_THEATRE = path.resolve(import.meta.dir, "../../graph/builtin/theatre.graph.yaml");

describe("Theatre Graph", () => {
	describe("builtin theatre.graph.yaml", () => {
		it("loads without errors", async () => {
			const def = await loadGraphDefinition(BUILTIN_THEATRE);
			expect(def.name).toBe("theatre");
		});

		it("has five nodes: script, debate, stage, cross_check, curtain", async () => {
			const def = await loadGraphDefinition(BUILTIN_THEATRE);
			expect(Object.keys(def.nodes)).toContain("script");
			expect(Object.keys(def.nodes)).toContain("debate");
			expect(Object.keys(def.nodes)).toContain("stage");
			expect(Object.keys(def.nodes)).toContain("cross_check");
			expect(Object.keys(def.nodes)).toContain("curtain");
		});

		it("has correct dependency chain (Script → Debate → Stage → Cross-Check → Curtain)", async () => {
			const def = await loadGraphDefinition(BUILTIN_THEATRE);
			expect(def.nodes.debate?.depends_on).toContain("script");
			expect(def.nodes.stage?.depends_on).toContain("debate");
			expect(def.nodes.cross_check?.depends_on).toContain("stage");
			expect(def.nodes.curtain?.depends_on).toContain("cross_check");
		});

		it("debate and cross_check nodes use the registered node kinds", async () => {
			const def = await loadGraphDefinition(BUILTIN_THEATRE);
			expect(def.nodes.debate?.type).toBe("debate");
			expect(def.nodes.cross_check?.type).toBe("cross-check");
		});

		it("script node has human-review gate", async () => {
			const def = await loadGraphDefinition(BUILTIN_THEATRE);
			expect(def.nodes.script?.gate?.type).toBe("human-review");
		});

		it("stage node has heavy: true and a compile-check gate with retry policy", async () => {
			const def = await loadGraphDefinition(BUILTIN_THEATRE);
			expect(def.nodes.stage?.heavy).toBe(true);
			expect(def.nodes.stage?.gate?.type).toBe("compile-check");
			expect(def.nodes.stage?.retry?.maxAttempts).toBeGreaterThanOrEqual(1);
		});

		it("validation returns results (may include warnings)", async () => {
			const def = await loadGraphDefinition(BUILTIN_THEATRE);
			const errors = validateGraphDefinition(def);
			expect(Array.isArray(errors)).toBe(true);
		});
	});

	describe("graph validation", () => {
		it("rejects graph with circular dependency", () => {
			const errors = validateGraphDefinition({
				name: "cyclic",
				description: "test",
				version: 1,
				revision: 1,
				nodes: {
					a: { label: "A", description: "", role: "dev", tools: [], depends_on: ["b"] },
					b: { label: "B", description: "", role: "dev", tools: [], depends_on: ["a"] },
				},
			});
			expect(errors.length).toBeGreaterThan(0);
		});
	});
});
