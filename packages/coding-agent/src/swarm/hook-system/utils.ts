/**
 * Hook System shared utilities.
 *
 * Common helpers used by builtin hooks — extracted to eliminate duplication
 * across the six builtin implementations (Phase B1 of SatoPi swarm v3
 * unified architecture).
 *
 * @module hook-system/utils
 */

import type { HookContext } from "./types";

/**
 * Extract a string agentId from payload or context.
 *
 * Resolution order:
 * 1. `payload.agentId` — if it is a string
 * 2. `ctx.agentId`     — fallback from hook context
 *
 * The payload parameter accepts a loose type so that this helper
 * works with both the typed HookPayloadMap entries and legacy callers.
 *
 * @returns The resolved agentId string, or `undefined` if neither source provides one.
 */
export function resolveAgentId(
  payload: { agentId?: unknown },
  ctx: HookContext,
): string | undefined {
  if (typeof payload.agentId === "string") return payload.agentId;
  if (typeof ctx.agentId === "string") return ctx.agentId;
  return undefined;
}
