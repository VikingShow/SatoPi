/**
 * compact-context.ts — L3 context compression (Mild / Aggressive / Emergency)
 *
 * Called before each LLM turn via AgentLoopConfig.transformContext.
 * Three-tier strategy:
 *   Mild      — replace stale tool results with offload summaries
 *   Aggressive — delete oldest messages (protecting MMD markers, user messages, tool-pair integrity)
 *   Emergency  — delete until token budget is under the emergency target
 *
 * Design follows the TencentDB L3 compact context pattern.
 */

import type { AgentMessage } from "@satopi/pi-agent-core";
import type { CompactionSettings } from "@satopi/pi-agent-core/compaction";
import { estimateTokens, resolveThresholdTokens } from "@satopi/pi-agent-core/compaction";

// ============================================================================
// Types
// ============================================================================

export interface CompactContextConfig {
	/** Mild offload: replace tool results with summaries at this ratio. Default 0.5 */
	mildRatio: number;
	/** Aggressive delete: delete oldest messages at this ratio. Default 0.85 */
	aggressiveRatio: number;
	/** Emergency: delete until below this ratio. Default 0.95 */
	emergencyRatio: number;
	/** Emergency target: delete until <= this ratio. Default 0.6 */
	emergencyTargetRatio: number;
	/** Context window size in tokens */
	contextWindow: number;
	/** Property name on custom messages that marks them as MMD context (protected from deletion) */
	mmdMarker: string;
}

export interface CompactContextResult {
	messages: AgentMessage[];
	mildApplied: boolean;
	aggressiveApplied: boolean;
	emergencyApplied: boolean;
	tokensBefore: number;
	tokensAfter: number;
}

// ============================================================================
// Defaults
// ============================================================================

export const DEFAULT_COMPACT_CONFIG: Omit<CompactContextConfig, "contextWindow"> = {
	mildRatio: 0.5,
	aggressiveRatio: 0.85,
	emergencyRatio: 0.95,
	emergencyTargetRatio: 0.6,
	mmdMarker: "_mmdContextMessage",
};

// ============================================================================
// Token helpers
// ============================================================================

function estimateTotalTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		total += estimateTokens(msg);
	}
	return total;
}

// ============================================================================
// Message property helpers
// ============================================================================

/**
 * Returns true when a message carries the MMD marker property.
 * Handles both standard Message types and custom agent messages.
 */
function hasMmdMarker(msg: AgentMessage, marker: string): boolean {
	return typeof msg === "object" && msg !== null && marker in msg;
}

/** Collect every tool-call id from an assistant message. */
function collectToolCallIds(msg: AgentMessage): string[] {
	if (msg.role !== "assistant") return [];
	const ids: string[] = [];
	const content = msg.content;
	if (!Array.isArray(content)) return [];
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "toolCall" &&
			"id" in block
		) {
			const id = block.id;
			if (typeof id === "string") ids.push(id);
		}
	}
	return ids;
}

// ============================================================================
// Mild: replace stale tool results with offload summaries
// ============================================================================

/**
 * Scan the last 70% of messages. Tool results whose toolCallId does NOT belong
 * to the most recent assistant message with tool calls ("current task") are
 * replaced with an `<offload>summary</offload>` XML block.
 */
function applyMild(
	messages: AgentMessage[],
	offloadSummaries: Map<string, string>,
	_config: CompactContextConfig,
): { messages: AgentMessage[]; applied: boolean } {
	const startIndex = Math.floor(messages.length * 0.3);

	// Find the most recent assistant message with tool calls — this defines "current task"
	const currentTaskToolCallIds = new Set<string>();
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const ids = collectToolCallIds(msg);
			if (ids.length > 0) {
				for (const id of ids) currentTaskToolCallIds.add(id);
				break;
			}
		}
	}

	let anyReplaced = false;
	const result = messages.map((msg, idx) => {
		if (idx < startIndex) return msg;
		if (msg.role !== "toolResult") return msg;

		const toolCallId = msg.toolCallId;
		if (typeof toolCallId !== "string") return msg;
		// Protect results from the current task
		if (currentTaskToolCallIds.has(toolCallId)) return msg;

		const summary = offloadSummaries.get(toolCallId);
		if (summary === undefined) return msg;

		anyReplaced = true;
		// Replace content with XML offload block, keeping other properties intact
		return {
			...msg,
			content: [{ type: "text" as const, text: `<offload>${summary}</offload>` }],
		} as AgentMessage;
	});

	return { messages: result, applied: anyReplaced };
}

// ============================================================================
// Shared: tool-pair index and protection
// ============================================================================

/**
 * Collect tool-call pairing data from the message list.
 */
function buildToolPairIndex(messages: AgentMessage[]): {
	toolResultIndexByCallId: Map<string, number>;
	assistantToolCallIds: Map<number, string[]>;
} {
	const toolResultIndexByCallId = new Map<string, number>();
	const assistantToolCallIds = new Map<number, string[]>();

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const ids = collectToolCallIds(msg);
			if (ids.length > 0) assistantToolCallIds.set(i, ids);
		}
		if (msg.role === "toolResult") {
			const toolCallId = msg.toolCallId;
			if (typeof toolCallId === "string") {
				toolResultIndexByCallId.set(toolCallId, i);
			}
		}
	}

	return { toolResultIndexByCallId, assistantToolCallIds };
}

/**
 * Extend the protected marker set with tool-pair integrity:
 * - If an assistant is protected, protect its tool results.
 * - If a tool result is protected, protect its assistant + sibling results.
 */
function protectToolPairs(
	markers: Set<number>,
	assistantToolCallIds: Map<number, string[]>,
	toolResultIndexByCallId: Map<string, number>,
): void {
	// Protect results of protected assistants
	for (const [assistantIdx, toolCallIds] of assistantToolCallIds) {
		if (markers.has(assistantIdx)) {
			for (const callId of toolCallIds) {
				const resultIdx = toolResultIndexByCallId.get(callId);
				if (resultIdx !== undefined) markers.add(resultIdx);
			}
		}
	}

	// Protect assistants of protected tool results (and their sibling results)
	for (const [callId, resultIdx] of toolResultIndexByCallId) {
		if (markers.has(resultIdx)) {
			for (const [assistantIdx, ids] of assistantToolCallIds) {
				if (ids.includes(callId)) {
					markers.add(assistantIdx);
					for (const siblingId of ids) {
						const siblingIdx = toolResultIndexByCallId.get(siblingId);
						if (siblingIdx !== undefined) markers.add(siblingIdx);
					}
				}
			}
		}
	}
}

// ============================================================================
// Aggressive: delete oldest messages with pair-safety and MMD protection
// ============================================================================

interface IndexedMessage {
	index: number;
	msg: AgentMessage;
	tokens: number;
}

/**
 * Delete oldest messages targeting ~40% reduction, while preserving:
 *  - MMD-marked messages
 *  - User messages
 *  - Tool-pair integrity (never orphan a tool_call / tool_result)
 */
function applyAggressive(
	messages: AgentMessage[],
	config: CompactContextConfig,
): { messages: AgentMessage[]; applied: boolean } {
	const totalTokens = estimateTotalTokens(messages);
	const targetTokens = totalTokens * 0.6; // keep ~60%
	const markers = new Set<number>();

	// Mark MMD messages and user messages as protected
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (hasMmdMarker(msg, config.mmdMarker)) markers.add(i);
		if (msg.role === "user") markers.add(i);
	}

	// Build tool-pair index and extend protection
	const { toolResultIndexByCallId, assistantToolCallIds } = buildToolPairIndex(messages);
	protectToolPairs(markers, assistantToolCallIds, toolResultIndexByCallId);

	// Partition messages into keep (protected) and discard (unprotected)
	const keptEntries: IndexedMessage[] = [];
	const discardEntries: IndexedMessage[] = [];
	let keptTokens = 0;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const tokens = estimateTokens(msg);
		if (markers.has(i)) {
			keptEntries.push({ index: i, msg, tokens });
			keptTokens += tokens;
		} else {
			discardEntries.push({ index: i, msg, tokens });
		}
	}

	// Discard oldest unprotected messages until we hit the token target
	let discardIdx = 0;
	let remainingDiscardTokens = discardEntries.reduce((sum, e) => sum + e.tokens, 0);

	while (discardIdx < discardEntries.length && keptTokens + remainingDiscardTokens > targetTokens) {
		remainingDiscardTokens -= discardEntries[discardIdx].tokens;
		discardIdx++;
	}

	// Rebuild: protected messages + tail of non-protected
	const kept = new Set<number>(keptEntries.map(e => e.index));
	for (let i = discardIdx; i < discardEntries.length; i++) {
		kept.add(discardEntries[i].index);
	}

	const result = messages.filter((_, i) => kept.has(i));
	return { messages: result, applied: result.length < messages.length };
}

// ============================================================================
// Emergency: delete until below emergency target
// ============================================================================

/**
 * Delete oldest messages until token count <= contextWindow * emergencyTargetRatio.
 * Uses the same keep/discard pattern as Aggressive for reliable protection.
 */
function applyEmergency(
	messages: AgentMessage[],
	config: CompactContextConfig,
): { messages: AgentMessage[]; applied: boolean } {
	const targetTokens = config.contextWindow * config.emergencyTargetRatio;
	const markers = new Set<number>();

	// Mark MMD messages and user messages as protected
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (hasMmdMarker(msg, config.mmdMarker)) markers.add(i);
		if (msg.role === "user") markers.add(i);
	}

	// Build tool-pair index and extend protection
	const { toolResultIndexByCallId, assistantToolCallIds } = buildToolPairIndex(messages);
	protectToolPairs(markers, assistantToolCallIds, toolResultIndexByCallId);

	// Partition into keep (protected) and discard (unprotected)
	const keptEntries: IndexedMessage[] = [];
	const discardEntries: IndexedMessage[] = [];
	let keptTokens = 0;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const tokens = estimateTokens(msg);
		if (markers.has(i)) {
			keptEntries.push({ index: i, msg, tokens });
			keptTokens += tokens;
		} else {
			discardEntries.push({ index: i, msg, tokens });
		}
	}

	// Discard oldest unprotected messages until we hit the hard token target
	// More aggressive than the Aggressive tier — keep deleting until target met
	let discardIdx = 0;
	let remainingDiscardTokens = discardEntries.reduce((sum, e) => sum + e.tokens, 0);

	while (discardIdx < discardEntries.length && keptTokens + remainingDiscardTokens > targetTokens) {
		remainingDiscardTokens -= discardEntries[discardIdx].tokens;
		discardIdx++;
	}

	// Rebuild: protected messages + remaining tail of non-protected
	const kept = new Set<number>(keptEntries.map(e => e.index));
	for (let i = discardIdx; i < discardEntries.length; i++) {
		kept.add(discardEntries[i].index);
	}

	const result = messages.filter((_, i) => kept.has(i));
	return { messages: result, applied: result.length < messages.length };
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Apply L3 compact context compression.
 *
 * Called before each LLM turn via AgentLoopConfig.transformContext.
 * Checks the token/contextWindow ratio and applies the appropriate tier.
 *
 * @param messages        The full message history
 * @param offloadSummaries Map from tool_call_id → offload summary text
 * @param config          Thresholds and context window configuration
 */
export function compactContext(
	messages: AgentMessage[],
	offloadSummaries: Map<string, string>,
	config: CompactContextConfig,
): CompactContextResult {
	const tokensBefore = estimateTotalTokens(messages);
	const ratio = tokensBefore / config.contextWindow;

	let result: { messages: AgentMessage[]; applied: boolean };
	let mildApplied = false;
	let aggressiveApplied = false;
	let emergencyApplied = false;

	if (ratio >= config.emergencyRatio) {
		const emergency = applyEmergency(messages, config);
		result = emergency;
		emergencyApplied = emergency.applied;
	} else if (ratio >= config.aggressiveRatio) {
		const aggressive = applyAggressive(messages, config);
		result = aggressive;
		aggressiveApplied = aggressive.applied;
	} else if (ratio >= config.mildRatio) {
		const mild = applyMild(messages, offloadSummaries, config);
		result = mild;
		mildApplied = mild.applied;
	} else {
		result = { messages, applied: false };
	}

	return {
		messages: result.messages,
		mildApplied,
		aggressiveApplied,
		emergencyApplied,
		tokensBefore,
		tokensAfter: estimateTotalTokens(result.messages),
	};
}

// ============================================================================
// Session-compaction coordination (P3 #3)
// ============================================================================

export type OffloadCompactTier = "none" | "mild" | "aggressive" | "emergency";

/**
 * Outcome of the most recent offload L3 compaction run — the explicit shared
 * signal between the two compaction pipelines.
 *
 * The offload side writes it after every `compactContext` run (per provider
 * request); the session-side threshold compaction reads it before paying for
 * a full history rewrite. The two pipelines previously shared zero state and
 * fought over the same conversation: the session rewrite would coarsen (via an
 * LLM summary call) history that the per-turn L3 tier was already keeping
 * within budget. The signal lets the session defer to L3 when it is sufficient.
 */
export interface OffloadCompactStatus {
	/** The L3 tier that applied; "none" when the request was already under the mild ratio. */
	tier: OffloadCompactTier;
	tokensBefore: number;
	tokensAfter: number;
	/** The context window the L3 compaction was configured with. */
	contextWindow: number;
	/** Epoch ms of the run (used to reject stale signals). */
	at: number;
}

/** Derive the tier + sizes for `result` as an {@link OffloadCompactStatus}. */
export function toOffloadCompactStatus(result: CompactContextResult, contextWindow: number): OffloadCompactStatus {
	const tier: OffloadCompactTier = result.emergencyApplied
		? "emergency"
		: result.aggressiveApplied
			? "aggressive"
			: result.mildApplied
				? "mild"
				: "none";
	return {
		tier,
		tokensBefore: result.tokensBefore,
		tokensAfter: result.tokensAfter,
		contextWindow,
		at: Date.now(),
	};
}

/** How long an offload compaction signal stays fresh (ms). */
export const OFFLOAD_COMPACT_FRESH_MS = 10 * 60_000;

/**
 * Session-side threshold decision: should the session's own (expensive,
 * history-rewriting) compaction defer to the offload L3 tier?
 *
 * Returns true only when the offload L3 compaction already ran on the most
 * recent provider request, applied a tier, and brought the effective request
 * under the same compaction threshold the session is about to trip on. In that
 * state the session rewrite would be redundant work that replaces the
 * per-tool-call detail L3 preserves with a single coarse summary. The status is
 * overwritten on every provider request (L3 runs per turn), so a present status
 * is inherently the just-sent request's outcome; the freshness window only
 * guards against a manager that stopped receiving L3 runs.
 */
export function shouldDeferSessionCompaction(
	contextWindow: number,
	settings: CompactionSettings,
	status: OffloadCompactStatus | undefined,
): boolean {
	if (!status) return false;
	if (status.tier === "none") return false;
	if (status.contextWindow !== contextWindow) return false;
	if (Date.now() - status.at > OFFLOAD_COMPACT_FRESH_MS) return false;
	const threshold = resolveThresholdTokens(contextWindow, settings);
	return status.tokensAfter <= threshold;
}
