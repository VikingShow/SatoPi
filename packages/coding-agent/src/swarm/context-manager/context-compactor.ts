import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
// compact() and shouldCompact() from oh-my-pi are available as:
// import { compact, shouldCompact, prepareCompaction } from "@oh-my-pi/pi-agent-core/compaction";

export interface CompactionStrategy {
  readonly name: string;

  /** Check if this strategy applies to the given agent state */
  appliesTo(tokensUsed: number, tokenBudget: number): boolean;

  /** Execute compaction, returning the compacted messages */
  compact(messages: AgentMessage[]): Promise<CompactedContext>;
}

export interface CompactedContext {
  messages: AgentMessage[];         // Replacement (shorter) message list
  summaryText?: string;             // Summary of what was compacted
  stigmergyMark?: {                 // Optional: place compacted info in stigmergy environment
    type: string;
    message: string;
  };
}

/**
 * Strategy: Summarize
 *
 * Keeps the most recent N messages, replaces older messages with a summary.
 * Best for long-running agents where old context may still be relevant.
 */
export class SummarizeStrategy implements CompactionStrategy {
  readonly name = "summarize";

  appliesTo(tokensUsed: number, tokenBudget: number): boolean {
    return tokensUsed > tokenBudget * 0.9;  // 90% threshold
  }

  async compact(messages: AgentMessage[]): Promise<CompactedContext> {
    // Keep last 20 messages, summarize older ones
    if (messages.length <= 20) return { messages };

    const recent = messages.slice(-20);
    const oldText = messages.slice(0, -20).map(m => {
      const text = typeof (m as { content?: unknown }).content === "string"
        ? (m as { content: string }).content.slice(0, 100)
        : "[non-text message]";
      return text;
    }).join("\n");

    const summary: AgentMessage = {
      role: "user" as const,
      content: `[Context Compaction Summary]\nPrevious discussion topics: ${oldText.slice(0, 500)}`,
      timestamp: Date.now(),
    };

    return {
      messages: [summary, ...recent],
      summaryText: `Compacted ${messages.length - 20} messages into summary`,
    };
  }
}

/**
 * Strategy: Truncate
 *
 * Simply keeps the most recent N messages, drops the rest.
 * Best for agents where old context is no longer relevant (e.g., completed tasks).
 */
export class TruncateStrategy implements CompactionStrategy {
  readonly name = "truncate";

  appliesTo(tokensUsed: number, tokenBudget: number): boolean {
    return tokensUsed > tokenBudget * 0.95;  // 95% threshold — more aggressive
  }

  async compact(messages: AgentMessage[]): Promise<CompactedContext> {
    const keep = Math.min(30, messages.length);
    return {
      messages: messages.slice(-keep),
      summaryText: `Truncated ${messages.length - keep} messages`,
    };
  }
}

/**
 * Strategy: OffloadToStigmergy
 *
 * Moves older context to stigmergy environment marks instead of keeping inline.
 * Best when context should be queryable but not in the agent's active memory.
 */
export class OffloadToStigmergyStrategy implements CompactionStrategy {
  readonly name = "offload-to-stigmergy";

  appliesTo(tokensUsed: number, tokenBudget: number): boolean {
    return tokensUsed > tokenBudget * 0.8;  // 80% threshold — proactive
  }

  async compact(messages: AgentMessage[]): Promise<CompactedContext> {
    const keep = messages.slice(-15);
    const oldText = messages.slice(0, -15).map(m => {
      const text = typeof (m as { content?: unknown }).content === "string"
        ? (m as { content: string }).content.slice(0, 200)
        : "";
      return text;
    }).filter(Boolean).join(" | ");

    return {
      messages: keep,
      stigmergyMark: {
        type: "context-offload",
        message: oldText.slice(0, 500),
      },
      summaryText: `Offloaded ${messages.length - 15} messages to stigmergy environment`,
    };
  }
}

/**
 * ContextCompactor
 *
 * Check if an agent's context needs compaction, and apply the appropriate strategy.
 *
 * Strategies are tried in order (first applicable wins):
 *   1. summarize — for moderate overflows
 *   2. offload-to-stigmergy — for proactive compaction
 *   3. truncate — for critical overflows
 */
export class ContextCompactor {
  private strategies: CompactionStrategy[];

  constructor() {
    this.strategies = [
      new SummarizeStrategy(),
      new OffloadToStigmergyStrategy(),
      new TruncateStrategy(),
    ];
  }

  /**
   * Check if compaction is needed and apply the best strategy.
   * Returns null if no compaction is needed.
   */
  async compactIfNeeded(
    messages: AgentMessage[],
    tokensUsed: number,
    tokenBudget: number,
  ): Promise<CompactedContext | null> {
    const strategy = this.strategies.find(s => s.appliesTo(tokensUsed, tokenBudget));
    if (!strategy) return null;

    return strategy.compact(messages);
  }

  /** Register as a HookPipeline hook (agent:beforeLaunch event) */
  createHook() {
    return {
      name: "context-compactor",
      priority: 3,  // After mnemopi, before experience
      events: ["agent:beforeLaunch" as const],
      phases: ["stage" as const],  // Only stage has long-running agents
      handler: async (event: string, payload: any) => {
        // payload would contain the agent's message history and token estimates
        // This is a placeholder for future integration
      },
    };
  }
}
