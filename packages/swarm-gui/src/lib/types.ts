/**
 * Frontend type definitions — aligned with backend SwarmState/AgentState/ActivityEntry.
 */

import type { ChatMessage as PiChatMessage, ChatChannel as PiChatChannel } from "@oh-my-pi/pi-web/types";

export type AgentStatus = "pending" | "waiting" | "running" | "completed" | "failed";
export type PipelineStatus = "idle" | "running" | "completed" | "failed" | "aborted";

/**
 * Loop phase — high-level workflow stage.
 * Drives the frontend UI state machine.
 * idle → before-loop-dialog → before-loop-debate → before-loop-confirm → running → after-loop → idle
 * running can transition to "blocked" (stagnation/deadlock) → user resolves → running
 * running can transition to "paused" (manual pause) → user resumes → running
 */
export type LoopPhase =
  | "idle"
  | "before-loop-dialog"
  | "before-loop-debate"
  | "before-loop-confirm"
  | "running"
  | "paused"
  | "blocked"
  | "after-loop";

/** Context payload broadcast when the loop is blocked awaiting user decision. */
export interface BlockerContext {
  iteration: number;
  lastFindings: string[];
  lastWorkerOutput: string;
  stagnationCount: number;
  workerCrashCounts: Record<string, number>;
  reason: string;
}

export type BlockerResolution = "continue" | "skip" | "abort";

export interface BeforeLoopState {
  phase: LoopPhase;
  task: string;
  conversationLength: number;
  planReady: boolean;
  busy: boolean;
}

export interface AgentState {
  name: string;
  status: AgentStatus;
  iteration: number;
  wave: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  praiseCount: number;
  criticismCount: number;
  conflictCount: number;
  mentorId?: string;
  role?: "reviewer";
}

/**
 * To-Do item — a structured task parsed from plan.md.
 * Tracks real-time completion status during loop execution.
 */
export interface TodoItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
  files?: string[];
  completedAt?: number;
}

export interface SwarmState {
  name: string;
  status: PipelineStatus;
  mode: string;
  iteration: number;
  targetCount: number;
  agents: Record<string, AgentState>;
  startedAt: number;
  completedAt?: number;
  loopIteration?: number;
  roundtablePhase?: string;
  reviewVerdict?: string;
  loopPhase?: LoopPhase;
  todos?: TodoItem[];
  /** P2-6: Cumulative input+output tokens across all agents. */
  totalTokens?: number;
  /** P2-6: Cumulative assistant request count across all agents. */
  totalRequests?: number;
}

export type ActivityEventType =
  | "broadcast" | "subgroup" | "steering" | "phase" | "convergence"
  | "verdict" | "conflict" | "scaling" | "nomination" | "crash";

export interface ActivityEntry {
  ts: number;
  type: ActivityEventType;
  from?: string;
  to?: string;
  body?: string;
  phase?: string;
  round?: number;
  iteration?: number;
  scope?: string;
  jaccard?: number;
  converged?: boolean;
  passed?: boolean;
  approval?: number;
  total?: number;
  findings?: string[];
  disagreed?: boolean;
  praised?: string[];
  criticized?: string[];
  file?: string;
  writers?: string[];
  severity?: string;
  action?: string;
  worker?: string;
  reason?: string;
  elected?: string | null;
  votes?: Record<string, string[]>;
  error?: string;
}

export type ChatChannel = Omit<PiChatChannel, "messageCount"> & {
  unreadCount: number;
  lastMessage?: string;
  lastMessageTime?: number;
};

export interface ChatMessage extends PiChatMessage {
  channelId: string;
  to: string;
  threadId?: string;
  threadReplies?: ChatMessage[];
}

export interface ModelOption {
  id: string;
  name: string;
  tier: string;
  provider?: string;
}

// ── After Loop types ──

export interface ExperienceLesson {
  type: "error" | "success" | "insight" | "pattern" | "warning" | "reflection";
  summary: string;
  detail: string;
  tags: string[];
  confidence: number;
  source: string;
}

export interface AfterLoopResult {
  runId: string;
  status: string;
  iterations: number;
  summaryMarkdown: string;
  lessons: ExperienceLesson[];
  reflection: {
    rootCauses: string[];
    effectivePatterns: string[];
    structuralIssues: string[];
    recommendations: string[];
    confidence: number;
  } | null;
  stats: {
    totalIterations: number;
    finalStatus: string;
    clonerApprovalRatio: number;
    workerCount: number;
    clonerCount: number;
  };
}

export interface ExperienceSearchResult {
  runId: string;
  timestamp: string;
  lesson: ExperienceLesson;
  rank: number;
}

export interface ExperienceStats {
  totalRuns: number;
  avgIterations: number;
  completionRate: number;
  escalationRate: number;
  avgApprovalRatio: number;
}

// ── Role Asset types ──

export type RoleStatus = "draft" | "proposed" | "approved" | "deprecated";

export interface RoleAsset {
  id: string;
  name: string;
  description: string;
  version: number;
  author: string;
  status: RoleStatus;
  prompts: {
    system: string;
    guidelines: string[];
  };
  tools: string[];
  tags: string[];
  created_at: string;
  updated_at: string;
  usage_count: number;
  success_rate: number;
}

export interface RoleAssetSummary {
  id: string;
  name: string;
  description: string;
  status: RoleStatus;
  version: number;
  tags: string[];
  usage_count: number;
  success_rate: number;
  updated_at: string;
}

export interface RoleCreateInput {
  id: string;
  name: string;
  description: string;
  author?: string;
  prompts: {
    system: string;
    guidelines: string[];
  };
  tools: string[];
  tags: string[];
}

export interface RoleUpdateInput {
  name?: string;
  description?: string;
  prompts?: {
    system?: string;
    guidelines?: string[];
  };
  tools?: string[];
  tags?: string[];
}
