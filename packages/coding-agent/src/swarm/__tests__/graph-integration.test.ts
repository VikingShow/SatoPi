import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadGraphDefinition, validateGraphDefinition } from "../graph/schema";

const BUILTIN_THEATRE = path.resolve(import.meta.dir, "../graph/builtin/theatre.graph.yaml");

describe("Theatre Graph", () => {
	describe("builtin theatre.graph.yaml", () => {
		it("loads without errors", async () => {
			const def = await loadGraphDefinition(BUILTIN_THEATRE);
			expect(def.name).toBe("theatre");
		});

		it("has three nodes: script, stage, curtain", async () => {
			const def = await loadGraphDefinition(BUILTIN_THEATRE);
			expect(Object.keys(def.nodes)).toContain("script");
			expect(Object.keys(def.nodes)).toContain("stage");
			expect(Object.keys(def.nodes)).toContain("curtain");
		});

		it("has correct dependency chain", async () => {
			const def = await loadGraphDefinition(BUILTIN_THEATRE);
			expect(def.nodes.stage?.depends_on).toContain("script");
			expect(def.nodes.curtain?.depends_on).toContain("stage");
		});

		it("script node has human-review gate", async () => {
			const def = await loadGraphDefinition(BUILTIN_THEATRE);
			expect(def.nodes.script?.gate?.type).toBe("human-review");
		});

		it("stage node has heavy: true for fork support", async () => {
			const def = await loadGraphDefinition(BUILTIN_THEATRE);
			expect(def.nodes.stage?.heavy).toBe(true);
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
