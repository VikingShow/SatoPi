// biome-ignore-all lint/suspicious/noTemplateCurlyInString: condition DSL literals
import { describe, expect, it } from "bun:test";
import { evaluateCondition, validateCondition } from "../condition";

/** Build a field reference like `${node}.field` without triggering template-literal lint. */
const DOLLAR = String.fromCharCode(36); // "$"
const fieldRef = (node: string, field: string): string => `${DOLLAR}{${node}}.${field}`;

describe("condition expression evaluator", () => {
	describe("field references", () => {
		it("resolves field success", () => {
			const ctx = { build: { success: true, exitCode: 0 } };
			expect(evaluateCondition(fieldRef("build", "success"), ctx)).toBe(true);
		});

		it("resolves field exitCode numeric comparison", () => {
			const ctx = { build: { exitCode: 0 } };
			expect(evaluateCondition(`${fieldRef("build", "exitCode")} == 0`, ctx)).toBe(true);
			expect(evaluateCondition(`${fieldRef("build", "exitCode")} != 0`, ctx)).toBe(false);
			expect(evaluateCondition(`${fieldRef("build", "exitCode")} > 1`, ctx)).toBe(false);
			expect(evaluateCondition(`${fieldRef("build", "exitCode")} >= 0`, ctx)).toBe(true);
		});

		it("returns false for missing nodes", () => {
			expect(evaluateCondition(fieldRef("missing", "success"), {})).toBe(false);
		});

		it("supports dot-inside-braces form ${node.field}", () => {
			const ctx = { loop: { item: 2, index: 1 } };
			expect(evaluateCondition("${loop.item} == 2", ctx)).toBe(true);
			expect(evaluateCondition("${loop.item} == 3", ctx)).toBe(false);
			expect(evaluateCondition("${loop.index} >= 0", ctx)).toBe(true);
		});
	});

	describe("string operators", () => {
		const ctx = { build: { output: "Build completed with ERROR: TS2345" } };

		it("contains", () => {
			expect(evaluateCondition(`${fieldRef("build", "output")} contains 'ERROR'`, ctx)).toBe(true);
			expect(evaluateCondition(`${fieldRef("build", "output")} contains 'WARN'`, ctx)).toBe(false);
		});

		it("startsWith / endsWith", () => {
			expect(evaluateCondition(`${fieldRef("build", "output")} startsWith 'Build'`, ctx)).toBe(true);
			expect(evaluateCondition(`${fieldRef("build", "output")} endsWith 'TS2345'`, ctx)).toBe(true);
		});
	});

	describe("null checks", () => {
		it("isNull / isNotNull", () => {
			expect(evaluateCondition(`${fieldRef("a", "error")} isNull`, { a: { success: true } })).toBe(true);
			expect(evaluateCondition(`${fieldRef("a", "error")} isNotNull`, { a: { error: "boom" } })).toBe(true);
		});
	});

	describe("logical operators", () => {
		const ctx = { build: { exitCode: 0 }, test: { success: true } };
		const build0 = `${fieldRef("build", "exitCode")} == 0`;
		const build1 = `${fieldRef("build", "exitCode")} == 1`;
		const testOk = fieldRef("test", "success");

		it("&& and ||", () => {
			expect(evaluateCondition(`${build0} && ${testOk}`, ctx)).toBe(true);
			expect(evaluateCondition(`${build1} && ${testOk}`, ctx)).toBe(false);
			expect(evaluateCondition(`${build1} || ${testOk}`, ctx)).toBe(true);
		});

		it("supports 'and' / 'or' keywords", () => {
			expect(evaluateCondition(`${build0} and ${testOk}`, ctx)).toBe(true);
			expect(evaluateCondition(`${build1} or ${testOk}`, ctx)).toBe(true);
			expect(evaluateCondition(`${build1} and ${testOk}`, ctx)).toBe(false);
		});

		it("! negation", () => {
			// build.success is absent → falsy → !falsy = true.
			expect(evaluateCondition(`!${fieldRef("build", "success")}`, ctx)).toBe(true);
			expect(evaluateCondition(`!(${build1})`, ctx)).toBe(true);
			expect(evaluateCondition(`!${testOk}`, ctx)).toBe(false);
		});

		it("parenthesized grouping", () => {
			expect(evaluateCondition(`(${build0}) && ${testOk}`, ctx)).toBe(true);
		});
	});

	describe("literal comparison", () => {
		it("compares against strings and numbers", () => {
			expect(evaluateCondition(`${fieldRef("a", "kind")} == 'dev'`, { a: { kind: "dev" } })).toBe(true);
			expect(evaluateCondition(`${fieldRef("a", "count")} >= 5`, { a: { count: 7 } })).toBe(true);
		});
	});

	describe("array indices", () => {
		const ctx = { results: { metadata: { loopResults: [{ success: true }, { success: false }] } } };

		it("accesses ${node}.field[0]", () => {
			expect(evaluateCondition("${results}.metadata.loopResults[0].success", ctx)).toBe(true);
			expect(evaluateCondition("${results}.metadata.loopResults[1].success", ctx)).toBe(false);
		});
	});

	describe("validateCondition", () => {
		it("accepts valid expressions", () => {
			expect(validateCondition(`${fieldRef("build", "exitCode")} == 0`)).toBeNull();
			expect(
				validateCondition(`(${fieldRef("a", "success")}) && ${fieldRef("b", "output")} contains 'x'`),
			).toBeNull();
		});

		it("rejects malformed expressions", () => {
			expect(validateCondition(`${fieldRef("build", "exitCode")} ==`)).not.toBeNull();
			expect(validateCondition(`${DOLLAR}{unclosed`)).not.toBeNull();
			expect(validateCondition("build.exitCode == 0")).not.toBeNull();
			expect(validateCondition("unknown_token")).not.toBeNull();
		});
	});
});
