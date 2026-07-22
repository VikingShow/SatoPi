/**
 * streaming.ts — Reusable streaming helpers for swarm agent subprocess output.
 *
 * All swarm agents that call runSubprocess share the same SSE streaming
 * pattern: logStreamStart → onProgress diff → logStreamEnd.  This module
 * eliminates the 5 duplicate copies of that boilerplate.
 */

import type { AgentProgress, SingleResult } from "@oh-my-pi/pi-coding-agent";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent";
import type { ActivityLogger } from "./activity-logger";

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
 * The handler diffs progress.recentOutput (reversed — newest line first)
 * against previously sent text so only new characters are dispatched.
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
	return (progress: AgentProgress) => {
		userOnProgress?.(progress);
		const lines = [...(progress.recentOutput ?? [])].reverse();
		const currentText = lines.join("\n");
		if (currentText.length > sentLen) {
			const delta = currentText.slice(sentLen);
			sentLen = currentText.length;
			activityLogger.logStreamDelta(msgId, from, delta);
		}
	};
}

// ============================================================================
// streamAgentOutput
// ============================================================================

/**
 * Run a swarm agent subprocess with SSE streaming baked in.
 *
 * Replaces the 10-line manual pattern:
 *
 *   activityLogger.logStreamStart(msgId, from);
 *   const result = await runSubprocess({
 *     ...,
 *     onProgress: (progress) => { … manual diff … }
 *   });
 *   activityLogger.logStreamEnd(msgId, from, result.output, result.thinking);
 *
 * with a single call:
 *
 *   const result = await streamAgentOutput(opts, runOptions);
 *
 * The function always emits a stream_start before execution and a
 * stream_end after (on both success and failure).  Callers that need
 * the raw result (e.g. for verdict extraction) can use the returned
 * Promise<SingleResult> directly.
 *
 * @param opts       Streaming metadata (logger, msgId, from, optional transform).
 * @param runOptions Options forwarded to runSubprocess.  The caller MUST NOT
 *                   set onProgress — we inject our own handler (pass a
 *                   userOnProgress to createStreamProgressHandler if needed).
 */
export function streamAgentOutput(
	opts: StreamAgentOptions,
	runOptions: Parameters<typeof runSubprocess>[0] & { userOnProgress?: (p: AgentProgress) => void },
): Promise<SingleResult> {
	opts.activityLogger.logStreamStart(opts.msgId, opts.from);

	return runSubprocess({
		...runOptions,
		onProgress: createStreamProgressHandler(
			opts.activityLogger,
			opts.msgId,
			opts.from,
			runOptions.userOnProgress,
		),
	}).then((result: SingleResult) => {
		const raw = result.output ?? "";
		const finalBody = opts.transformOutput ? opts.transformOutput(raw) : (raw || "(no output)");
		opts.activityLogger.logStreamEnd(opts.msgId, opts.from, finalBody, result.thinking);
		return result;
	}).catch((err: unknown) => {
		const errMsg = err instanceof Error ? err.message : String(err);
		opts.activityLogger.logStreamEnd(opts.msgId, opts.from, `[Error] ${errMsg}`, undefined);
		throw err;
	});
}
