/**
 * Gate normalisation helpers.
 *
 * Types and validation constants have been moved to packages/coding-agent/src/graph/types.ts.
 * This file re-exports them for backward compatibility and provides the normalisation logic.
 */

export type {
	GateMode,
	GateResult,
	GateSpec,
	GateType,
	RawGateSpec,
	RawRetrySpec,
	RetryOnFailure,
	RetrySpec,
	RetryStrategy,
} from "../../graph/types";
export { VALID_GATE_MODES, VALID_GATE_TYPES, VALID_ON_FAILURE, VALID_RETRY_STRATEGIES } from "../../graph/types";

import type {
	GateMode,
	GateSpec,
	GateType,
	RawGateSpec,
	RawRetrySpec,
	RetryOnFailure,
	RetrySpec,
	RetryStrategy,
} from "../../graph/types";
import { VALID_GATE_MODES, VALID_GATE_TYPES, VALID_ON_FAILURE, VALID_RETRY_STRATEGIES } from "../../graph/types";

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
