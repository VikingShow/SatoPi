/**
 * ttsr-state.ts — pure state container for time-traveling stream rule (TTSR)
 * orchestration. Stage 6a extraction (SessionCompactor pattern): the heavy
 * orchestration stays in AgentSession's private methods so they can access its
 * internals directly; this class only owns the TTSR field state.
 */
import type { Rule } from "../../capability/rule";
import type { TtsrManager } from "../../export/ttsr";

export class TtsrState {
	manager: TtsrManager | undefined = undefined;
	pendingInjections: Rule[] = [];
	/** Per-tool TTSR rules whose `interruptMode` opted out of aborting the stream.
	 *  These are folded into the matched tool call's `toolResult` content as an
	 *  in-band system reminder, instead of spawning a separate follow-up turn. */
	perToolInjections = new Map<string, Rule[]>();
	abortPending = false;
	retryToken = 0;
	resumePromise: Promise<void> | undefined = undefined;
	resumeResolve: (() => void) | undefined = undefined;
}
