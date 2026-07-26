/**
 * OffloadManager — unified interface for the offload subsystem.
 *
 * Combines two previously separate placeholder interfaces:
 *   1. hook-system/builtins/offload-hook.ts — summarizeL1 / forceFlush (hook direction)
 *   2. context-manager/sources/offload-source.ts — getMmdContext / getExperienceContext (context direction)
 *
 * A single instance is passed to both the HookPipeline (via registerBuiltinHooks)
 * and the ContextPipeline (via OffloadSource), so the summarize→store→inject
 * pipeline is closed.
 */

import { logger } from "@oh-my-pi/pi-utils";

// ---------------------------------------------------------------------------
// Unified interface
// ---------------------------------------------------------------------------

export interface IOffloadManager {
  /** L1 summarization of an agent's output (hook direction). */
  summarizeL1(agentId: string, content: unknown): Promise<void>;
  /** Force-flush pending offload data to persistent storage (hook direction). */
  forceFlush(): Promise<void>;
  /** Get MMD context for agent spawn injection (context direction). */
  getMmdContext(agentId: string, taskDescription: string): Promise<string | null>;
  /** Get experience context for agent spawn injection (context direction). */
  getExperienceContext(agentId: string, taskDescription: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// No-op implementation — logs and returns null/void.
// Replace with a real implementation that delegates to OffloadPipeline
// once SwarmOffloadStore + SessionStorage wiring is available in the session factory.
// ---------------------------------------------------------------------------

export class NoopOffloadManager implements IOffloadManager {
  async summarizeL1(_agentId: string, _content: unknown): Promise<void> {
    // TODO: delegate to OffloadPipeline.runL1() when SessionStorage is wired
  }
  async forceFlush(): Promise<void> {
    // TODO: delegate to OffloadPipeline.runL2() when phases are available
  }
  async getMmdContext(_agentId: string, _taskDescription: string): Promise<string | null> {
    logger.debug("[NoopOffloadManager] getMmdContext called (no-op until wired)");
    return null;
  }
  async getExperienceContext(_agentId: string, _taskDescription: string): Promise<string | null> {
    logger.debug("[NoopOffloadManager] getExperienceContext called (no-op until wired)");
    return null;
  }
}
