/**
 * Shared types for the monitor subsystem.
 *
 * Extracted to avoid circular imports between activity-logger ↔ monitor/server.
 * Both modules import from here instead of each other.
 */

import type { ActivityEntry } from "../activity-logger";

// -- Broadcaster interface (decouples ActivityLogger from MonitorServer) --
export interface ActivityBroadcaster {
  broadcast(sessionName: string, entry: ActivityEntry): void;
}

// -- AfterLoop result (shared between standalone.ts and api-routes.ts) --
export interface AfterLoopResult {
  runId: string;
  status: string;
  iterations: number;
  summaryMarkdown: string;
  lessons: Array<{
    type: string;
    summary: string;
    detail: string;
    tags: string[];
    confidence: number;
    source: string;
  }>;
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
    agentCount: number;
    reviewerCount: number;
  };
}
