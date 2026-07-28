/**
 * GateController — gate execution, retry, and failure handling for Theatre Graph nodes.
 *
 * Each GraphNode may define a {@link GateSpec} that runs after the agent completes.
 * The controller runs the appropriate gate (compile-check, test, lsp, human-review,
 * or script), collects results, and drives the retry / block / continue decision
 * loop when a gate fails.
 *
 * ## Gate types
 *   compile-check — bash command, pass on exit 0
 *   test          — bash command, pass on exit 0
 *   lsp           — bash command + structured diagnostic parsing
 *   human-review  — emit event → TUI gate panel → await human decision
 *   script        — bash command, pass on exit 0
 *
 * ## Retry backoff strategies (from schema)
 *   exponential — delay = baseDelayMs * 2^attempt
 *   constant    — delay = baseDelayMs (same every attempt)
 *   linear      — delay = baseDelayMs * (attempt + 1)
 *
 * ## Exhaustion behaviour (RetryOnFailure from schema)
 *   block      — return a block action (permanent failure)
 *   skip       — return continue (let the pipeline proceed despite failure)
 *   ask-human  — emit event → TUI gate panel → await human decision
 */

import { EventEmitter } from "node:events";
import { logger } from "@oh-my-pi/pi-utils";
import type { GateMode, GateSpec, GraphNode, RetrySpec, RetryStrategy } from "./schema";

// ============================================================================
// GateController-specific types
// ============================================================================

/** Result of executing a gate. */
export interface GateResult {
	/** Whether the gate passed. */
	passed: boolean;
	/** Human-readable error messages collected from the gate output. */
	errors: string[];
	/** Whether the failure is likely to be fixable by an agent. */
	fixable: boolean;
	/** Process exit code (undefined for non-bash gates). */
	exitCode?: number;
	/** Raw combined stdout+stderr from the gate command. */
	output?: string;
}

/**
 * Action produced by {@link GateController.handleGateFailure} that tells the
 * orchestrator what to do next.
 */
export type GateAction = { type: "retry"; delayMs: number } | { type: "block"; reason: string } | { type: "continue" };

// ============================================================================
// Human-review event payload
// ============================================================================

/** Payload emitted on the `"human-review-request"` event. */
export interface HumanReviewRequest {
	/** Node label so the TUI can display context. */
	nodeLabel: string;
	/** Gate type (always "human-review" here). */
	gateType: "human-review";
	/** Prompt text from the gate spec for the human reviewer. */
	prompt: string;
	/** Predefined choices from the gate spec. */
	options: string[];
	/** Unique id the TUI must pass back to {@link GateController.resolveHumanGate}. */
	reviewId: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Default timeout for bash-based gate commands (2 minutes). */
const DEFAULT_GATE_TIMEOUT_MS = 120_000;

/** Hard cap on computed backoff delay to prevent unbounded waits. */
const MAX_DELAY_MS = 120_000;

/** Patterns that indicate a compiler / linter error (fixable). */
const FIXABLE_PATTERNS: RegExp[] = [
	/\berror\b.*TS\d{4}/i, // TypeScript compiler errors
	/^error/i, // Generic "error" prefixed
	/lint_error/i, // Linter violations
	/\btype .* is not assignable/i,
	/\bproperty .* does not exist/i,
	/\bcannot find (name|module)/i,
	/\bunused (variable|import|parameter)/i,
	/\bmissing return type/i,
];

/** Patterns that indicate a runtime / env failure (not fixable by agent). */
const NON_FIXABLE_PATTERNS: RegExp[] = [
	/\bout of memory\b/i,
	/\bdisk full\b/i,
	/\bnetwork (error|unreachable|timed out)\b/i,
	/\bpermission denied\b/i,
	/\bcannot connect\b/i,
	/\bauthentication (failed|required)\b/i,
	/\brate limit\b/i,
	/\bENOENT\b/i,
	/\bECONNREFUSED\b/i,
	/\bEACCES\b/i,
];

// ============================================================================
// GateController
// ============================================================================

/**
 * Runs gates for Theatre Graph nodes, handles failures, and drives the
 * retry / block / continue decision loop.
 *
 * ## Human-review flow
 *   1. GateController emits `"human-review-request"` with a {@link HumanReviewRequest}.
 *   2. The TUI's gate panel presents the request to the user.
 *   3. The user decides → TUI calls {@link resolveHumanGate} with a {@link GateAction}.
 *   4. The awaiting promise resolves with the user's choice.
 *
 * ## Events
 *   - `"human-review-request"` (HumanReviewRequest) — emitted when a human-review
 *     decision is needed (either from `human-review` gate or `ask-human` retry exhaustion).
 *   - `"human-review-resolved"` (HumanReviewRequest) — emitted after resolution.
 */
export class GateController extends EventEmitter {
	/** Workspace root — default cwd for gate commands. */
	readonly #workspace: string;
	/** Default per-gate timeout. */
	readonly #defaultTimeout: number;

	/**
	 * Pending human-review resolvers keyed by review id.
	 * Each entry waits for {@link resolveHumanGate} to be called.
	 */
	#pendingReviews = new Map<
		string,
		{
			resolve: (action: GateAction) => void;
			reject: (err: Error) => void;
		}
	>();

	/** Monotonic counter for unique review ids. */
	#reviewCounter = 0;

	constructor(opts: { workspace: string; defaultTimeout?: number }) {
		super();
		this.#workspace = opts.workspace;
		this.#defaultTimeout = opts.defaultTimeout ?? DEFAULT_GATE_TIMEOUT_MS;
	}

	// ========================================================================
	// Public API
	// ========================================================================

	/**
	 * Execute the gate attached to `node` and return the result.
	 *
	 * When no gate is configured the result is always a pass.
	 *
	 * @param node     The graph node whose gate to run.
	 * @param _agentOutput Raw output from the agent (for future LSP context).
	 */
	async runGate(node: GraphNode, _agentOutput: string, agentSucceeded = true): Promise<GateResult> {
		const gate = node.gate;
		if (!gate) {
			return { passed: true, errors: [], fixable: false };
		}

		// "on-failure" mode: skip gate when the agent succeeded.
		// The gate only runs when the agent already failed.
		if (gate.mode === "on-failure" && agentSucceeded) {
			return { passed: true, errors: [], fixable: false };
		}

		switch (gate.type) {
			case "compile-check":
			case "test":
			case "script":
				return this.#runBashGate(gate, node.label);

			case "lsp":
				return this.#runLspGate(gate, node.label);

			case "human-review":
				return this.#evaluateHumanReviewGate(gate);

			default: {
				const _exhaustive: never = gate.type;
				logger.warn("GateController: unknown gate type", {
					type: _exhaustive,
					node: node.label,
				});
				return { passed: true, errors: [], fixable: false };
			}
		}
	}

	/**
	 * Determine the next action after a gate failure.
	 *
	 * Consults the node's {@link RetrySpec}:
	 *  1. Compute backoff delay using `strategy` and `attempt`.
	 *  2. If attempts remain → `{ type: "retry", delayMs }`.
	 *  3. If exhausted → consult `onFailure`:
	 *     - `"block"`     → `{ type: "block", reason }`
	 *     - `"skip"`      → `{ type: "continue" }`
	 *     - `"ask-human"` → await human decision via event
	 *
	 * @param node    The node whose gate failed.
	 * @param result  The failing GateResult.
	 * @param attempt The 0-based attempt number (0 = first failure → first retry).
	 */
	async handleGateFailure(node: GraphNode, result: GateResult, attempt: number): Promise<GateAction> {
		const retry = node.retry;
		if (!retry) {
			return {
				type: "block",
				reason: `Gate "${node.label}" failed with no retry policy configured.`,
			};
		}

		// attempt counts retries already attempted. 0 = haven't retried yet.
		// maxAttempts counts total execution attempts including the first.
		const retriesLeft = retry.maxAttempts - 1 - attempt;

		if (retriesLeft > 0) {
			const delayMs = this.#computeBackoff(retry.strategy, retry.baseDelayMs, attempt);
			logger.info("GateController: retry scheduled", {
				node: node.label,
				attempt,
				retriesLeft,
				delayMs,
				strategy: retry.strategy,
			});
			return { type: "retry", delayMs };
		}

		// Exhausted — consult onFailure.
		switch (retry.onFailure) {
			case "block":
				return {
					type: "block",
					reason: `Gate "${node.label}" exhausted ${retry.maxAttempts} attempt(s).`,
				};

			case "skip":
				logger.info("GateController: skipping gate failure (onFailure=skip)", {
					node: node.label,
					errors: result.errors,
				});
				return { type: "continue" };

			case "ask-human": {
				const prompt = [
					`Gate "${node.label}" failed after ${retry.maxAttempts} attempt(s):`,
					"",
					result.errors.slice(0, 10).join("\n"),
					"",
					"What should we do?",
				].join("\n");

				return this.#awaitHumanDecision({
					nodeLabel: node.label,
					prompt,
					options: ["block", "skip"],
				});
			}

			default: {
				const _exhaustive: never = retry.onFailure;
				logger.warn("GateController: unknown onFailure", { onFailure: _exhaustive });
				return {
					type: "block",
					reason: `Unknown onFailure value: ${String(_exhaustive)}`,
				};
			}
		}
	}

	/**
	 * Resolve a pending human-review gate.
	 *
	 * Called by the TUI gate panel after the user makes a decision.
	 *
	 * @param nodeLabel The node label matching the pending review.
	 * @param action    The user's chosen action.
	 * @returns `true` if a matching review was found and resolved.
	 */
	resolveHumanGate(nodeLabel: string, action: GateAction): boolean {
		// Search for the oldest pending review for this node.
		// Keys are `${nodeLabel}:${counter}` — pick the first lexicographically.
		let foundKey: string | undefined;
		for (const key of this.#pendingReviews.keys()) {
			if (key.startsWith(`${nodeLabel}:`)) {
				foundKey = key;
				break;
			}
		}

		if (!foundKey) {
			logger.warn("GateController: resolveHumanGate called with no matching review", {
				nodeLabel,
			});
			return false;
		}

		const entry = this.#pendingReviews.get(foundKey)!;
		entry.resolve(action);
		this.#pendingReviews.delete(foundKey);

		logger.info("GateController: human gate resolved", {
			nodeLabel,
			action: action.type,
			reviewId: foundKey,
		});
		return true;
	}

	/**
	 * Reject a pending human-review gate (e.g. TUI closed, timeout).
	 */
	rejectHumanGate(nodeLabel: string, reason: string): boolean {
		let foundKey: string | undefined;
		for (const key of this.#pendingReviews.keys()) {
			if (key.startsWith(`${nodeLabel}:`)) {
				foundKey = key;
				break;
			}
		}

		if (!foundKey) return false;

		const entry = this.#pendingReviews.get(foundKey)!;
		entry.reject(new Error(reason));
		this.#pendingReviews.delete(foundKey);
		return true;
	}

	// ========================================================================
	// Gate implementations
	// ========================================================================

	/**
	 * Run a bash-based gate (compile-check, test, script).
	 */
	async #runBashGate(gate: GateSpec, nodeLabel: string): Promise<GateResult> {
		if (!gate.command) {
			return {
				passed: false,
				errors: [`Gate type "${gate.type}" requires a command but none was configured.`],
				fixable: true,
			};
		}

		const { exitCode, output } = await this.#runCommand(gate.command);
		const passed = exitCode === 0;
		const errors = passed ? [] : this.#extractErrors(output, nodeLabel);
		const fixable = passed ? false : this.#isFixable(output);

		return { passed, errors, fixable, exitCode, output };
	}

	/**
	 * Run an LSP-based gate (bash command that produces structured diagnostics).
	 *
	 * The command should emit structured output (e.g. biome JSON, tsc JSON).
	 * We parse known formats; unrecognised output falls back to plain-text parsing.
	 */
	async #runLspGate(gate: GateSpec, nodeLabel: string): Promise<GateResult> {
		if (!gate.command) {
			return {
				passed: false,
				errors: [`Gate type "lsp" requires a command but none was configured.`],
				fixable: true,
			};
		}

		const { exitCode, output } = await this.#runCommand(gate.command);

		const diagnostics = this.#tryParseLspOutput(output);
		if (diagnostics !== null) {
			const passed = diagnostics.length === 0;
			return {
				passed,
				errors: diagnostics,
				fixable: !passed, // LSP diagnostics are always fixable
				exitCode,
				output,
			};
		}

		// Fall back to plain-text error extraction.
		const passed = exitCode === 0;
		const errors = passed ? [] : this.#extractErrors(output, nodeLabel);
		const fixable = passed ? false : this.#isFixable(output);

		return { passed, errors, fixable, exitCode, output };
	}

	/**
	 * Evaluate a human-review gate.
	 *
	 * Mode behaviour:
	 *   `"always"`     — trigger review unconditionally (return !passed).
	 *   `"on-failure"` — the orchestrator decides; gate returns passed.
	 *   `"never"`      — skip (return passed).
	 */
	#evaluateHumanReviewGate(gate: GateSpec): GateResult {
		const mode: GateMode = gate.mode ?? "always";

		switch (mode) {
			case "never":
				return { passed: true, errors: [], fixable: false };

			case "on-failure":
				// The orchestrator calls runGate even when the agent failed,
				// and interprets "on-failure" gates as pending review only on agent failure.
				// Here we return passed; the caller decides.
				return { passed: true, errors: [], fixable: false };

			case "always": {
				const prompt = gate.prompt ?? "Human review required for this node.";
				return {
					passed: false,
					errors: [prompt],
					fixable: false,
				};
			}

			default: {
				const _exhaustive: never = mode;
				return { passed: true, errors: [], fixable: false };
			}
		}
	}

	// ========================================================================
	// Human-review decision loop
	// ========================================================================

	/**
	 * Emit a human-review request event and await the TUI's decision.
	 *
	 * Returns a {@link GateAction} that the orchestrator should carry out.
	 */
	async #awaitHumanDecision(opts: { nodeLabel: string; prompt: string; options: string[] }): Promise<GateAction> {
		const reviewId = `${opts.nodeLabel}:${++this.#reviewCounter}`;
		const request: HumanReviewRequest = {
			nodeLabel: opts.nodeLabel,
			gateType: "human-review",
			prompt: opts.prompt,
			options: opts.options,
			reviewId,
		};

		const { promise, resolve, reject } = Promise.withResolvers<GateAction>();

		this.#pendingReviews.set(reviewId, { resolve, reject });

		logger.info("GateController: awaiting human review", {
			nodeLabel: opts.nodeLabel,
			reviewId,
		});
		this.emit("human-review-request", request);

		try {
			return await promise;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn("GateController: human review rejected", { reviewId, error: message });
			return { type: "block", reason: `Human review aborted: ${message}` };
		}
	}

	// ========================================================================
	// Backoff computation
	// ========================================================================

	/**
	 * Compute the delay before the next retry based on the strategy.
	 */
	#computeBackoff(strategy: RetryStrategy, baseDelayMs: number, attempt: number): number {
		let raw: number;
		switch (strategy) {
			case "exponential":
				raw = baseDelayMs * 2 ** attempt;
				break;
			case "constant":
				raw = baseDelayMs;
				break;
			case "linear":
				raw = baseDelayMs * (attempt + 1);
				break;
			default: {
				const _exhaustive: never = strategy;
				raw = baseDelayMs;
			}
		}
		return Math.min(raw, MAX_DELAY_MS);
	}

	// ========================================================================
	// Helpers
	// ========================================================================

	/**
	 * Execute a shell command via Bun.spawn and capture output + exit code.
	 */
	async #runCommand(command: string): Promise<{ exitCode: number; output: string }> {
		try {
			const proc = Bun.spawn(["bash", "-c", command], {
				cwd: this.#workspace,
				stdout: "pipe",
				stderr: "pipe",
			});

			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);

			let exitCode: number;
			if (this.#defaultTimeout) {
				const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<"timeout">();
				const timer = setTimeout(() => timeoutResolve("timeout"), this.#defaultTimeout);
				const deadlineResult = await Promise.race([proc.exited.then(() => "exited" as const), timeoutPromise]);
				clearTimeout(timer);
				if (deadlineResult === "timeout") {
					proc.kill();
					exitCode = -1;
				} else {
					exitCode = proc.exitCode ?? -1;
				}
			} else {
				exitCode = await proc.exited;
			}

			const output = [stdout, stderr].filter(s => s.length > 0).join("\n");
			return { exitCode, output };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.warn("GateController: command spawn failed", { command, error: message });
			return { exitCode: -1, output: `[SPAWN ERROR] ${message}` };
		}
	}

	/**
	 * Extract human-readable error lines from gate output.
	 */
	#extractErrors(output: string, _nodeLabel: string): string[] {
		const lines = output.split("\n");
		const errors: string[] = [];

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			if (
				trimmed.includes("error") ||
				trimmed.includes("Error") ||
				trimmed.startsWith("TS") ||
				trimmed.includes(": FAIL") ||
				trimmed.includes("failed")
			) {
				errors.push(trimmed);
			}
		}

		// If nothing matched, include the last 10 lines as context.
		if (errors.length === 0) {
			const tail = lines
				.slice(-10)
				.map(l => l.trim())
				.filter(Boolean);
			for (const line of tail) errors.push(line);
		}

		// Cap at 20 errors to avoid flooding.
		return errors.slice(0, 20);
	}

	/**
	 * Heuristic: are these errors likely fixable by an agent?
	 *
	 * Compiler / linter errors are fixable; infrastructure failures are not.
	 */
	#isFixable(output: string): boolean {
		if (NON_FIXABLE_PATTERNS.some(p => p.test(output))) {
			return false;
		}
		if (FIXABLE_PATTERNS.some(p => p.test(output))) {
			return true;
		}
		// Default: assume fixable (optimistic for agent-driven workflows).
		return true;
	}

	/**
	 * Try to parse structured LSP diagnostic output (JSON arrays).
	 *
	 * Supports:
	 *   - biome `--reporter=json`  → [{ filename, diagnostics: [{ message }] }]
	 *   - Standard LSP Diagnostic[] → [{ message }]
	 *
	 * Returns null if the output doesn't match a known format.
	 */
	#tryParseLspOutput(output: string): string[] | null {
		const trimmed = output.trim();
		if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return null;

		try {
			const parsed: unknown = JSON.parse(trimmed);
			const errors: string[] = [];

			if (Array.isArray(parsed)) {
				for (const item of parsed) {
					if (item && typeof item === "object") {
						const diagnostics = "diagnostics" in item ? (item as Record<string, unknown>).diagnostics : null;
						const filename = "filename" in item ? (item as Record<string, unknown>).filename : null;
						if (diagnostics && Array.isArray(diagnostics)) {
							for (const d of diagnostics) {
								if (d && typeof d === "object" && "message" in d) {
									const prefix = typeof filename === "string" ? `${filename}: ` : "";
									errors.push(`${prefix}${(d as Record<string, unknown>).message}`);
								}
							}
						} else if ("message" in item) {
							errors.push((item as Record<string, unknown>).message as string);
						}
					}
				}
			}

			return errors.length > 0 || Array.isArray(parsed) ? errors : null;
		} catch {
			return null;
		}
	}
}
