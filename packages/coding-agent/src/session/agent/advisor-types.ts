/**
 * advisor-types.ts — shared advisor type (stage 6a split). Extracted from
 * AgentSession so both the session class and AdvisorState can reference it
 * without a circular import.
 */
import type { Agent, ThinkingLevel } from "@satopi/pi-agent-core";
import type { Model } from "@satopi/pi-ai";
import type { AdviseTool, AdvisorEmissionGuard, AdvisorRuntime, AdvisorTranscriptRecorder } from "../../advisor";

/** A live advisor instance bound to the session. */
export interface ActiveAdvisor {
	/** Display name from config ("default" for the legacy no-YAML advisor). */
	name: string;
	/** Slug for the transcript filename/session id; "" → `__advisor.jsonl`. */
	slug: string;
	agent: Agent;
	runtime: AdvisorRuntime;
	adviseTool: AdviseTool;
	emissionGuard: AdvisorEmissionGuard;
	recorder: AdvisorTranscriptRecorder;
	/** Latest recorder close, awaited by dispose() so the final turn lands on disk. */
	recorderClosed: Promise<void>;
	/** Unsubscribe for the advisor agent's event stream feeding the recorder. */
	agentUnsubscribe?: () => void;
	model: Model;
	thinkingLevel: ThinkingLevel;
	/** Stable key for the resolved runtime inputs that require a rebuild to change. */
	signature: string;
}
