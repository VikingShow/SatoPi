/**
 * ISwarmOrchestrator — shared interface for swarm orchestration engines.
 *
 * Implemented by GraphRunner (theatre graph engine and swarm keyword mode).
 * TUI components and agent-session reference this interface so the engine
 * is swappable.
 */
import type { ModelRegistry, Settings } from "@satopi/pi-coding-agent";
import type { ProfileRegistry } from "../agent/agent-profile";
import type { RoleAssetManager } from "../agent/role-asset";
import type { ActivityLogger } from "../infra/activity-logger";
import type { Chapter, StateTracker, SwarmState } from "../swarm/core/state";
import type { SwarmRuntime } from "../swarm/core/swarm-runtime";
import type { DebateRoundtableResult } from "./behaviors/debate-roundtable";

// ============================================================================
// Configuration
// ============================================================================

export interface EmbeddedSwarmConfig {
	/** Project workspace directory. */
	workspace: string;
	/** Swarm work directory (auto-created as .stp/sessions/swarm-{id}/). */
	swarmDir: string;
	/** Model registry for API key resolution. */
	modelRegistry: ModelRegistry;
	/** Settings for model and tool configuration. */
	settings: Settings;
	/** Optional role asset manager for role resolution (auto-created if omitted). */
	roleAssetManager?: RoleAssetManager;
	/** Optional profile registry for agent identity. */
	profileRegistry?: ProfileRegistry;
	/** Optional user-specified max worker count (default 4). */
	maxWorkers?: number;
	/** Optional user-specified max rounds (default 3). */
	maxRounds?: number;
	/** Whether to auto-applaud after Curtain (default: false). */
	autoApplaud?: boolean;
	/** Active MMD content for MmdSource context injection. */
	activeMmd?: string;
}

// ============================================================================
// Events
// ============================================================================

export interface SwarmPhaseEvent {
	phase: Chapter;
	subStatus: string;
	progress?: {
		currentWave?: number;
		totalWaves?: number;
		completedTasks?: number;
		totalTasks?: number;
	};
}

export interface SwarmAgentEvent {
	agentId: string;
	status: string;
	output?: string;
	error?: string;
}

export type SwarmEventCallback = (event: SwarmPhaseEvent | SwarmAgentEvent) => void;

// ============================================================================
// ISwarmOrchestrator
// ============================================================================

/**
 * Common orchestrator interface.  TUI components and agent-session reference
 * this interface so the engine is swappable.
 */
export interface ISwarmOrchestrator {
	init(): Promise<void>;
	dispose(): Promise<void>;
	onPlanUpdated(content: string): void;
	getPlanContent(): string;
	confirmScript(opts?: { agentType?: "swift" | "main"; agentCount?: number }): Promise<string[]>;
	setAgentConfig(opts: { agentType?: "swift" | "main"; agentCount?: number }): void;
	steer(message: string): Promise<void>;
	applaud(): void;
	pauseStage(): Promise<void>;
	/** Resume graph execution from last checkpoint. Returns success/error. */
	resumeGraphRun?(): Promise<{ success: boolean; error?: string }>;
	/**
	 * Run plan debate and return results without affecting FSM state.
	 * Returns undefined when debate is not enabled. Callers should:
	 * 1. Replace the displayed plan with result.refinedPlan
	 * 2. Use the round data to build a diff-based annotation summary
	 */
	debatePlan?(planContent: string): Promise<DebateRoundtableResult | undefined>;
	/**
	 * Attach this orchestrator to a Crew channel for phase transition broadcasts.
	 */
	attachCrew?(crewId: string, channel: unknown): void;
	/**
	 * Detach from the current Crew channel.
	 */
	detachCrew?(): void;
	readonly stateTracker: StateTracker;
	readonly activityLogger: ActivityLogger;
	readonly swarmState: Readonly<SwarmState>;
	readonly currentPhase: Chapter | null;
	readonly isRunning: boolean;
	readonly runtime: SwarmRuntime;
	/** Whether the Stage phase has been started (confirmScript was called and succeeded). */
	readonly stageStarted: boolean;
}
