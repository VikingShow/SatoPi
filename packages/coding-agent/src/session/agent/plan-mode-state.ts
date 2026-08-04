/**
 * plan-mode-state.ts — pure state container for plan-mode orchestration.
 * Stage 6a extraction (SessionCompactor pattern): the heavy orchestration stays
 * in AgentSession's private methods so they can access its internals directly;
 * this class only owns the plan-mode field state.
 */
import type { PlanModeState } from "../../plan-mode/state";

export class PlanModeStateContainer {
	/** Current plan-mode state machine (undefined → not in plan mode). */
	state: PlanModeState | undefined;
	/** True once the plan.md reference has been sent to the model this session. */
	referenceSent = false;
	/** Stable reference path for plan.md (default local://PLAN.md). */
	referencePath = "local://PLAN.md";
	/** Persistent plan-mode reminder scheduling state. */
	reminderCount = 0;
	reminderAwaitingProgress = false;
}
