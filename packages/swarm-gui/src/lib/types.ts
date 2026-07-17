/**
 * Frontend type definitions — aligned with backend SwarmState/AgentState/ActivityEntry.
 */

export type AgentStatus = "pending" | "waiting" | "running" | "completed" | "failed";
export type PipelineStatus = "idle" | "running" | "completed" | "failed" | "aborted";

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

export interface ChatChannel {
  id: string;
  type: "roundtable" | "subgroup" | "private" | "steering";
  name: string;
  participants: string[];
  unreadCount: number;
  lastMessage?: string;
  lastMessageTime?: number;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  from: string;
  to: string;
  body: string;
  timestamp: number;
  threadId?: string;
  threadReplies?: ChatMessage[];
}

export interface ModelOption {
  id: string;
  name: string;
  tier: string;
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
