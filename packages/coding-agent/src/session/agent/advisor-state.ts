/**
 * advisor-state.ts — pure state container for advisor (WATCHDOG.yml) lifecycle
 * orchestration. Stage 6a extraction (SessionCompactor pattern): the heavy
 * orchestration stays in AgentSession's private methods so they can access its
 * internals directly; this class only owns the advisor field state.
 */
import type { AgentTool } from "@satopi/pi-agent-core";
import type { AdvisorConfig } from "../../advisor";
import type { ActiveAdvisor } from "./advisor-types";

export class AdvisorState {
	/** Latched true when the user deliberately interrupts (USER_INTERRUPT_LABEL);
	 *  suppresses advisor concern/blocker auto-resume until the user next resumes.
	 *  Advisor advice is still recorded into the transcript, just not auto-run. */
	autoResumeSuppressed = false;
	primaryTurnsCompleted = 0;
	interruptImmuneTurnStart: number | undefined;
	enabled = false;
	tools?: AgentTool[];
	watchdogPrompt?: string;
	sharedInstructions?: string;
	contextPrompt?: string;
	yieldQueueUnsubscribe?: () => void;
	/** Live advisors. Empty when no advisor is active. */
	advisors: ActiveAdvisor[] = [];
	/** Configured advisor roster from WATCHDOG.yml; undefined/empty → single legacy advisor. */
	configs?: AdvisorConfig[];
	/** Provider-facing UUIDv7 identities keyed by primary provider session and advisor slug. */
	providerSessionIds = new Map<string, string>();
	/** Aggregate of the most recent stop's recorder closes; awaited by dispose() and
	 *  used as the open barrier for the next build so two writers never share a file. */
	recorderClosed: Promise<void> = Promise.resolve();
}
