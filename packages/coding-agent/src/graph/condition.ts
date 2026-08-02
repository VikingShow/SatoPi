/**
 * condition.ts — safe conditional-expression evaluator for graph routing.
 *
 * Evaluates route/edge conditions written in a restricted DSL — no arbitrary
 * JS. Supports field references into upstream node outputs plus comparison,
 * string, and logical operators.
 *
 * Supported grammar:
 *   expr        := orExpr
 *   orExpr      := andExpr ( "||" andExpr )*
 *   andExpr     := notExpr ( "&&" notExpr )*
 *   notExpr     := "!" notExpr | primary
 *   primary     := comparison | "(" expr ")" | boolean
 *   comparison  := operand op operand
 *   op          := "==" | "!=" | ">" | "<" | ">=" | "<=" | "contains"
 *                | "startsWith" | "endsWith" | "isNull" | "isNotNull"
 *   operand     := fieldRef | string | number | boolean
 *   fieldRef    := "${" ident "." ident "}"
 *   ident       := [a-zA-Z_][a-zA-Z0-9_]*
 *
 * Example:  (${build}.exitCode == 0) && ${test}.success
 *
 * The evaluator is intentionally minimal and non-Turing-complete; it cannot
 * execute code or access globals.
 */

// ============================================================================
// Tokenizer
// ============================================================================

type Token =
	| { kind: "ident"; value: string }
	| { kind: "string"; value: string }
	| { kind: "number"; value: number }
	| { kind: "bool"; value: boolean }
	| { kind: "field"; node: string; field: string }
	| { kind: "op"; value: string }
	| { kind: "lparen" }
	| { kind: "rparen" }
	| { kind: "eof" };

const KEYWORDS: Record<string, "bool"> = { true: "bool", false: "bool" };

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const n = input.length;

	while (i < n) {
		const ch = input[i]!;

		if (ch === " " || ch === "\t" || ch === "\n") {
			i++;
			continue;
		}

		// Field reference. Supports two forms, each with optional dot-chain:
		//   ${node}.field(.sub)*  — closing brace right after the node name
		//   ${node.field(.sub)*}  — dot inside the braces
		if (ch === "$" && input[i + 1] === "{") {
			const end = input.indexOf("}", i);
			if (end === -1) throw new Error("Unterminated field reference");

			let node: string;
			let field: string;
			let next = end + 1;

			if (input[end + 1] === ".") {
				// ${node}.field(.sub)*
				node = input.slice(i + 2, end).trim();
				let j = end + 2;
				while (j < n && /[a-zA-Z0-9_\-.]/.test(input[j]!)) j++;
				field = input.slice(end + 2, j);
				next = j;
			} else {
				// ${node.field(.sub)*}
				const inner = input.slice(i + 2, end);
				const dot = inner.indexOf(".");
				if (dot === -1) throw new Error(`Field reference missing '.' in '${inner}'`);
				node = inner.slice(0, dot).trim();
				field = inner.slice(dot + 1).trim();
			}

			if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(node)) {
				throw new Error(`Invalid field node reference '${node}'`);
			}
			if (!/^[a-zA-Z_][a-zA-Z0-9_\-.]*$/.test(field) || !field) {
				throw new Error(`Invalid field name '${field}'`);
			}
			tokens.push({ kind: "field", node, field });
			i = next;
			continue;
		}

		// String literal (single or double quoted)
		if (ch === '"' || ch === "'") {
			const quote = ch;
			let j = i + 1;
			let value = "";
			while (j < n && input[j] !== quote) {
				if (input[j] === "\\" && j + 1 < n) {
					value += input[j + 1];
					j += 2;
				} else {
					value += input[j];
					j++;
				}
			}
			if (j >= n) throw new Error("Unterminated string literal");
			tokens.push({ kind: "string", value });
			i = j + 1;
			continue;
		}

		// Number literal
		if (/[0-9]/.test(ch) || (ch === "-" && /[0-9]/.test(input[i + 1] ?? ""))) {
			let j = i + 1;
			while (j < n && /[0-9.]/.test(input[j]!)) j++;
			const value = Number(input.slice(i, j));
			if (Number.isNaN(value)) throw new Error(`Invalid number '${input.slice(i, j)}'`);
			tokens.push({ kind: "number", value });
			i = j;
			continue;
		}

		// Identifiers / keywords / operators
		if (/[a-zA-Z_]/.test(ch)) {
			let j = i + 1;
			while (j < n && /[a-zA-Z0-9_]/.test(input[j]!)) j++;
			const word = input.slice(i, j);
			if (word in KEYWORDS) {
				tokens.push({ kind: "bool", value: word === "true" });
			} else if (
				word === "contains" ||
				word === "startsWith" ||
				word === "endsWith" ||
				word === "isNull" ||
				word === "isNotNull" ||
				word === "and" ||
				word === "or"
			) {
				tokens.push({ kind: "op", value: word });
			} else {
				throw new Error(`Unknown identifier '${word}'`);
			}
			i = j;
			continue;
		}

		// Operators
		const two = input.slice(i, i + 2);
		if (two === "==" || two === "!=" || two === ">=" || two === "<=" || two === "&&" || two === "||") {
			tokens.push({ kind: "op", value: two });
			i += 2;
			continue;
		}
		if (ch === ">" || ch === "<" || ch === "!") {
			tokens.push({ kind: "op", value: ch });
			i++;
			continue;
		}
		if (ch === "(") {
			tokens.push({ kind: "lparen" });
			i++;
			continue;
		}
		if (ch === ")") {
			tokens.push({ kind: "rparen" });
			i++;
			continue;
		}

		throw new Error(`Unexpected character '${ch}' at position ${i}`);
	}

	tokens.push({ kind: "eof" });
	return tokens;
}

// ============================================================================
// Parser (recursive descent)
// ============================================================================

interface ConditionValue {
	readonly kind: "field" | "string" | "number" | "bool";
	node?: string;
	field?: string;
	value?: string | number | boolean;
}

class Parser {
	readonly #tokens: Token[];
	#pos = 0;

	constructor(input: string) {
		this.#tokens = tokenize(input);
	}

	#peek(): Token {
		return this.#tokens[this.#pos]!;
	}

	#next(): Token {
		return this.#tokens[this.#pos++]!;
	}

	parse(): boolean {
		const value = this.#parseOr();
		const tok = this.#peek();
		if (tok.kind !== "eof") throw new Error("Unexpected trailing input");
		return value;
	}

	#parseOr(): boolean {
		let left = this.#parseAnd();
		while (true) {
			const tok = this.#peek();
			if (tok.kind !== "op" || tok.value !== "||") break;
			this.#next();
			const right = this.#parseAnd();
			left = left || right;
		}
		return left;
	}

	#parseAnd(): boolean {
		let left = this.#parseNot();
		while (true) {
			const tok = this.#peek();
			if (tok.kind !== "op" || tok.value !== "&&") break;
			this.#next();
			const right = this.#parseNot();
			left = left && right;
		}
		return left;
	}

	#parseNot(): boolean {
		const tok = this.#peek();
		if (tok.kind === "op" && tok.value === "!") {
			this.#next();
			return !this.#parseNot();
		}
		return this.#parsePrimary();
	}

	#parsePrimary(): boolean {
		const tok = this.#peek();

		// Parenthesized expression
		if (tok.kind === "lparen") {
			this.#next();
			const value = this.#parseOr();
			const close = this.#next();
			if (close.kind !== "rparen") throw new Error("Expected ')'");
			return value;
		}

		// Bare boolean
		if (tok.kind === "bool") {
			this.#next();
			return tok.value;
		}

		// Comparison
		const left = this.#parseOperand();
		const opTok = this.#peek();

		if (opTok.kind === "op" && (opTok.value === "isNull" || opTok.value === "isNotNull")) {
			this.#next();
			return this.#evalUnary(left, opTok.value);
		}

		// Bare operand (no operator) — treat as truthy.
		if (opTok.kind !== "op" || !this.#isComparisonOp(opTok.value)) {
			const value = this.#resolve(left);
			return Boolean(value);
		}

		this.#next();
		const right = this.#parseOperand();
		return this.#evalComparison(left, opTok.value, right);
	}

	#isComparisonOp(op: string): boolean {
		return (
			op === "==" ||
			op === "!=" ||
			op === ">" ||
			op === "<" ||
			op === ">=" ||
			op === "<=" ||
			op === "contains" ||
			op === "startsWith" ||
			op === "endsWith"
		);
	}

	#parseOperand(): ConditionValue {
		const tok = this.#next();
		switch (tok.kind) {
			case "field":
				return { kind: "field", node: tok.node, field: tok.field };
			case "string":
				return { kind: "string", value: tok.value };
			case "number":
				return { kind: "number", value: tok.value };
			case "bool":
				return { kind: "bool", value: tok.value };
			default:
				throw new Error(`Expected operand, got '${JSON.stringify(tok)}'`);
		}
	}

	#evalUnary(left: ConditionValue, op: string): boolean {
		const leftValue = this.#resolve(left);
		const isNull = leftValue === null || leftValue === undefined;
		if (op === "isNull") return isNull;
		return !isNull;
	}

	#evalComparison(left: ConditionValue, op: string, right: ConditionValue): boolean {
		const l = this.#resolve(left);
		const r = this.#resolve(right);

		switch (op) {
			case "==":
				return l === r;
			case "!=":
				return l !== r;
			case ">":
				return (l as number) > (r as number);
			case "<":
				return (l as number) < (r as number);
			case ">=":
				return (l as number) >= (r as number);
			case "<=":
				return (l as number) <= (r as number);
			case "contains":
				return String(l).includes(String(r));
			case "startsWith":
				return String(l).startsWith(String(r));
			case "endsWith":
				return String(l).endsWith(String(r));
			default:
				throw new Error(`Unknown operator '${op}'`);
		}
	}

	#resolve(value: ConditionValue): unknown {
		if (value.kind !== "field") return value.value;
		// Field resolution happens via the context passed to the evaluator —
		// the parser defers to an injected resolver so the evaluator can map
		// ${nodeId}.field onto actual runtime outputs.
		return this.resolveField(value.node!, value.field!);
	}

	resolveField: (node: string, field: string) => unknown = () => {
		throw new Error("Field resolver not injected");
	};
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Context passed to {@link evaluateCondition}. Keyed by node id; each value
 * is a flat map of field → value (e.g. `{ success, output, exitCode }`).
 * Field references like `${build}.exitCode` resolve against this shape.
 */
export type ConditionContext = Record<string, unknown>;

/**
 * Evaluate a condition expression against a set of upstream node outputs.
 * Throws on syntax errors; returns false when referenced nodes are missing.
 */
export function evaluateCondition(expr: string, ctx: ConditionContext): boolean {
	const parser = new Parser(expr);
	parser.resolveField = (node, field) => {
		const out = ctx[node];
		if (!out) return undefined;
		// Walk dot-chain paths: field may be "a" or "a.b.c".
		let current: unknown = out;
		for (const part of field.split(".")) {
			if (current === null || typeof current !== "object") return undefined;
			current = (current as Record<string, unknown>)[part];
			if (current === undefined) return undefined;
		}
		return current;
	};
	return parser.parse();
}

/**
 * Validate a condition expression's syntax without evaluating it.
 * Returns an error message string, or null when the expression is valid.
 */
export function validateCondition(expr: string): string | null {
	try {
		// Tokenize + parse with a throwaway resolver; syntax errors surface here.
		const parser = new Parser(expr);
		parser.resolveField = () => undefined;
		parser.parse();
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}
