/**
 * streaming.ts — Reusable streaming helpers for swarm agent subprocess output.
 *
 * All swarm agents that call runSubprocess share the same SSE streaming
 * pattern: logStreamStart → onProgress diff → logStreamEnd.  This module
 * eliminates the 5 duplicate copies of that boilerplate.
 */

import type { AgentProgress } from "@oh-my-pi/pi-coding-agent";
import type { ActivityLogger } from "../infra/activity-logger";

// ============================================================================
// Types
// ============================================================================

export interface StreamAgentOptions {
	activityLogger: ActivityLogger;
	msgId: string;
	from: string;
	/**
	 * Optional post-processor applied to the final output before it is
	 * pushed as stream_end body.  Use this when the LLM wraps its reply
	 * in JSON (e.g. parseSocratesResponse) and you only want to surface
	 * the human-readable field.
	 *
	 * Default: passthrough — the raw output is used as-is.
	 */
	transformOutput?: (raw: string) => string;
}

// ============================================================================
// createStreamProgressHandler
// ============================================================================

/**
 * Build an onProgress callback that emits stream_delta via ActivityLogger.
 *
 * Maintains a full-text accumulator independent of the recentOutput ring buffer
 * so that content is never lost when the buffer rotates (recentOutput only keeps
 * the last 8 lines).  When the ring buffer drops old lines, we find the overlap
 * between the full accumulator and the ring buffer's remaining text, then append
 * only genuinely new characters.
 *
 * @param activityLogger  Logger for SSE / session.jsonl streaming events.
 * @param msgId           Unique stream message id (must match logStreamStart).
 * @param from            Agent name shown in the UI (e.g. "socrates").
 * @param userOnProgress  Optional caller-provided onProgress for side-effects.
 */
export function createStreamProgressHandler(
	activityLogger: ActivityLogger,
	msgId: string,
	from: string,
	userOnProgress?: (progress: AgentProgress) => void,
): (progress: AgentProgress) => void {
	let sentLen = 0;
	/** Full-text accumulator that never shrinks — survives ring buffer rotation. */
	let fullOutput = "";
	return (progress: AgentProgress) => {
		userOnProgress?.(progress);
		// Forward thinking/reasoning chunks in real-time
		if (progress.thinkingDelta) {
			activityLogger.logStreamThinking(msgId, from, progress.thinkingDelta);
		}
		const lines = [...(progress.recentOutput ?? [])].reverse();
		const ringText = lines.join("\n");

		// Merge ring buffer text into the full accumulator.
		// When output is shorter than the ring window, ringText grows monotonically.
		// When the ring buffer rotates and drops old lines, ringText may shrink —
		// we find the overlap with fullOutput and append only the new suffix.
		if (ringText.length >= fullOutput.length) {
			fullOutput = ringText;
		} else {
			// Ring buffer rotated — find where ringText overlaps with the tail
			// of fullOutput so we can append genuinely new content.
			const overlap = tailOverlap(fullOutput, ringText);
			fullOutput = fullOutput + ringText.slice(overlap);
		}

		if (fullOutput.length > sentLen) {
			const delta = fullOutput.slice(sentLen);
			sentLen = fullOutput.length;
			activityLogger.logStreamDelta(msgId, from, delta);
		}
	};
}

/**
 * Find the length of the longest suffix of \`full\` that is also a prefix of \`ring\`.
 * When the ring buffer rotates, its remaining content should overlap with the
 * tail of our full accumulator.  Returns the overlap length — \`ring.slice(overlap)\`
 * is the genuinely new content to append.
 */
function tailOverlap(full: string, ring: string): number {
	// Walk backwards from the maximum possible overlap
	const maxOverlap = Math.min(ring.length, full.length);
	for (let i = maxOverlap; i >= 0; i--) {
		if (full.endsWith(ring.slice(0, i))) {
			return i;
		}
	}
	return 0; // no overlap found — append entire ringText
}


// streamAgentOutput removed — use AgentRuntime.spawn() instead (SP-2 convergence).
