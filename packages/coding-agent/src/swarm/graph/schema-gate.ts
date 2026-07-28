/**
 * Gate types, retry specifications, and normalisation helpers extracted from schema.ts.
 *
 * These types are used by GraphNode, GraphDefaults (schema.ts), and GateController
 * (gate-controller.ts). Extracted here to keep schema.ts under 500 lines.
 */

// ============================================================================
// Discriminated unions
// ============================================================================

/** Gate types map to built-in verification steps. */
export type GateType = "compile-check" | "test" | "lsp" | "human-review" | "script";

/** When the gate check should run. */
export type GateMode = "always" | "on-failure" | "never";

/** Retry backoff strategy. */
export type RetryStrategy = "exponential" | "constant" | "linear";

/** What happens when all retry attempts are exhausted. */
export type RetryOnFailure = "block" | "skip" | "ask-human";

// ============================================================================
// Gate & retry interfaces
// ============================================================================

/**
 * Gate specification — a verification gate that runs before/after a node.
 */
export interface GateSpec {
	/** Built-in gate type or custom script gate. */
	type: GateType;
	/** Shell command for compile-check/test/lsp/script gates. */
	command?: string;
	/** Prompt text for human-review gates. */
	prompt?: string;
	/** Choices presented to the human reviewer. */
	options?: string[];
	/** When the gate should trigger (default: "always"). */
	mode?: GateMode;
}

/** Retry configuration for node execution failures. */
export interface RetrySpec {
	/** Maximum number of retry attempts (>= 1). */
	maxAttempts: number;
	/** Backoff strategy for inter-attempt delays. */
	strategy: RetryStrategy;
	/** Base delay in milliseconds before the first retry. */
	baseDelayMs: number;
	/** Behavior when all attempts are exhausted. */
	onFailure: RetryOnFailure;
}

/**
 * Outcome of gate validation after node execution.
 */
export interface GateResult {
	/** Whether all gates passed. */
	passed: boolean;
	/** Descriptions of failed gates. */
	failures: string[];
	/** Whether the human must review before proceeding. */
	humanReviewRequired: boolean;
	/** Recommended retry strategy based on failure type. */
	retryStrategy?: "immediate" | "fixup" | "human";
}

// ============================================================================
// Raw YAML shapes (snake_case input)
// ============================================================================

export interface RawGateSpec {
	type: string;
	command?: string;
	prompt?: string;
	options?: string[];
	mode?: string;
}

export interface RawRetrySpec {
	max_attempts: number;
	strategy: string;
	base_delay_ms: number;
	on_failure: string;
}

// ============================================================================
// Validation constants
// ============================================================================

export const VALID_GATE_TYPES: Record<string, true> = {
	"compile-check": true,
	test: true,
	lsp: true,
	"human-review": true,
	script: true,
};

export const VALID_GATE_MODES: Record<string, true> = { always: true, "on-failure": true, never: true };

export const VALID_RETRY_STRATEGIES: Record<string, true> = { exponential: true, constant: true, linear: true };

export const VALID_ON_FAILURE: Record<string, true> = { block: true, skip: true, "ask-human": true };

// ============================================================================
// Normalisation helpers
// ============================================================================

/**
 * Normalise raw YAML retry fields into a typed RetrySpec.
 * Throws on invalid strategy / on_failure / constraint violations.
 */
export function normalizeRetrySpec(raw: RawRetrySpec): RetrySpec {
	if (raw.max_attempts < 1) {
		throw new Error("retry.max_attempts must be >= 1");
	}
	if (!VALID_RETRY_STRATEGIES[raw.strategy]) {
		throw new Error(
			`Invalid retry strategy '${raw.strategy}'. Must be one of: ${Object.keys(VALID_RETRY_STRATEGIES).join(", ")}`,
		);
	}
	if (raw.base_delay_ms < 0) {
		throw new Error("retry.base_delay_ms must be >= 0");
	}
	if (!VALID_ON_FAILURE[raw.on_failure]) {
		throw new Error(
			`Invalid on_failure '${raw.on_failure}'. Must be one of: ${Object.keys(VALID_ON_FAILURE).join(", ")}`,
		);
	}
	return {
		maxAttempts: raw.max_attempts,
		strategy: raw.strategy as RetryStrategy,
		baseDelayMs: raw.base_delay_ms,
		onFailure: raw.on_failure as RetryOnFailure,
	};
}

/**
 * Normalise raw YAML gate fields into a typed GateSpec.
 * Throws on invalid type / mode.
 */
export function normalizeGateSpec(raw: RawGateSpec): GateSpec {
	if (!VALID_GATE_TYPES[raw.type]) {
		throw new Error(`Invalid gate type '${raw.type}'. Must be one of: ${Object.keys(VALID_GATE_TYPES).join(", ")}`);
	}
	if (raw.mode !== undefined && !VALID_GATE_MODES[raw.mode]) {
		throw new Error(`Invalid gate mode '${raw.mode}'. Must be one of: ${Object.keys(VALID_GATE_MODES).join(", ")}`);
	}
	return {
		type: raw.type as GateType,
		command: raw.command,
		prompt: raw.prompt,
		options: raw.options,
		mode: raw.mode as GateMode | undefined,
	};
}
