/**
 * HookPipeline — the central hook registry and trigger engine.
 *
 * Manages hook registration, priority-ordered execution, phase filtering,
 * error isolation, and short-circuit behaviour.
 *
 * @module hook-system/hook-pipeline
 */

import { logger } from "@satopi/pi-utils";

import type { HookContext, HookEvent, HookPayloadMap, HookRegistration } from "./types";

// ---------------------------------------------------------------------------
// HookPipeline
// ---------------------------------------------------------------------------

/**
 * Registry and executor for lifecycle hooks.
 *
 * Usage:
 * ```ts
 * const pipeline = new HookPipeline();
 * pipeline.register(createProfileHook(profileRegistry));
 * await pipeline.trigger("agent:beforeSpawn", { agentId: "a1" }, { phase: "script" });
 * ```
 */
export class HookPipeline {
	/** Internal map keyed by hook name for O(1) unregister. */
	#hooks: Map<string, HookRegistration> = new Map();

	// -----------------------------------------------------------------------
	// Registration
	// -----------------------------------------------------------------------

	/**
	 * Register a hook with the pipeline.
	 *
	 * If a hook with the same name already exists, it is overwritten and
	 * a warning is logged.
	 */
	register(hook: HookRegistration): void {
		if (this.#hooks.has(hook.name)) {
			logger.warn("[HookPipeline] Overwriting existing hook", {
				name: hook.name,
			});
		}
		this.#hooks.set(hook.name, hook);
	}

	/**
	 * Remove a previously registered hook by name.
	 *
	 * No-op if the name is not found.
	 */
	unregister(name: string): void {
		this.#hooks.delete(name);
	}

	// -----------------------------------------------------------------------
	// Execution
	// -----------------------------------------------------------------------

	/**
	 * Trigger an event against all matching hooks.
	 *
	 * Execution order:
	 * 1. Sort all hooks by priority (ascending).
	 * 2. Filter: hook must subscribe to `event`.
	 * 3. Filter: if hook has `phases`, `ctx.phase` must be in the list.
	 * 4. Execute sequentially. If a handler returns `false`, stop remaining.
	 * 5. If a handler throws, log the error and continue (isolation).
	 */
	async trigger<K extends HookEvent>(event: K, payload: HookPayloadMap[K], ctx: HookContext): Promise<void> {
		const sorted = this.list();

		for (const hook of sorted) {
			// Event subscription check
			if (!hook.events.includes(event)) {
				continue;
			}

			// Phase filter check — if phases is defined (even as empty array),
			// the hook is restricted to those phases. Empty array = never fires.
			if (hook.phases !== undefined) {
				const currentPhase = ctx.phase;
				if (!currentPhase || !hook.phases.includes(currentPhase)) {
					continue;
				}
			}

			try {
				const result = await hook.handler(event, payload, ctx);
				if (result === false) {
					logger.debug("[HookPipeline] Hook returned false — short-circuiting", {
						name: hook.name,
						event,
					});
					break;
				}
			} catch (err: unknown) {
				logger.error("[HookPipeline] Hook threw error — continuing", {
					name: hook.name,
					event,
					error: err instanceof Error ? err.message : String(err),
				});
				// Error isolation: continue with next hook
			}
		}
	}

	// -----------------------------------------------------------------------
	// Introspection
	// -----------------------------------------------------------------------

	/**
	 * Return all registered hooks sorted by priority (ascending).
	 */
	list(): ReadonlyArray<HookRegistration> {
		return Array.from(this.#hooks.values()).sort((a, b) => a.priority - b.priority);
	}
}
