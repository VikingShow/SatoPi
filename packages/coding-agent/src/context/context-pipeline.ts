/**
 * context-pipeline.ts — ContextPipeline system for SatoPi swarm v3.
 *
 * Assembles agent context by running registered ContextSource implementations
 * in priority order. Each source contributes fragments (system prompt additions,
 * task prompt additions, injected messages, tools) that are merged into a
 * final AssembledContext.
 *
 * The pipeline's `toTransformContext()` method produces an
 * `AgentLoopConfig["transformContext"]` implementation — this is the key
 * integration point with SatoPi's agent loop.
 *
 * ## Location Decision (2026-07-30)
 * ContextPipeline moved from swarm/context-manager/ to src/context/.
 * All imports updated. Relative structure (context-pipeline.ts alongside sources/) preserved.
 */

import type { AgentLoopConfig, AgentMessage } from "@satopi/pi-agent-core";
import { logger } from "@satopi/pi-utils";
import type { HookPipeline } from "../hooks/hook-pipeline";
import type { HookContext } from "../hooks/types";
import { compactContext, DEFAULT_COMPACT_CONFIG } from "../offload/compact";
import type { Chapter } from "../swarm/core/state";

// ============================================================================
// Types
// ============================================================================

/**
 * Describes the current workflow phase for source filtering.
 * Mirrors the PhaseInfo concept from the swarm v3 unified architecture.
 */
export interface PhaseInfo {
	phase: Chapter;
	multiAgent: boolean;
	humanMode: "dialogue" | "observer" | "passive" | "none";
}

/**
 * Input context available to all ContextSource implementations.
 */
export interface BuildContext {
	taskDescription: string;
	workspace: string;
	swarmDir: string;
	planContent?: string;
	turnNumber: number;
	phase: PhaseInfo;
	/** Previously accumulated fragments from higher-priority sources. */
	accumulated: Partial<AssembledContext>;
}

/**
 * A fragment of context produced by a single ContextSource.
 */
export interface ContextFragment {
	systemPromptAddition?: string;
	taskPromptAddition?: string;
	injectedMessages?: AgentMessage[];
	tools?: string[];
}

/**
 * Minimal agent spec passed to sources — contains enough information
 * for role-based and task-based context resolution.
 */
export interface AgentSpecLike {
	id: string;
	role: string;
	task: string;
}

/**
 * The fully assembled context ready for injection into the agent loop.
 */
export interface AssembledContext {
	systemPrompt: string;
	taskPrompt: string;
	tools: string[];
	injectedMessages: AgentMessage[];
	/** Source name to content mapping for debugging. */
	metadata: Record<string, string>;
}

// ============================================================================
// ContextSource interface
// ============================================================================

/**
 * A source of agent context.
 *
 * Each source is responsible for one dimension of context
 * (e.g. role definition, profile, experience, stigmergy signals).
 * Sources are filtered by phase and agent role, then executed in
 * priority order.
 */
export interface ContextSource {
	/** Unique name for debugging and metadata tracking. */
	readonly name: string;
	/** Execution priority — lower numbers execute first. */
	readonly priority: number;
	/**
	 * Whether this source applies to the given phase and agent role.
	 * Used to filter out irrelevant sources before execution.
	 */
	appliesTo(phase: Chapter, agentRole: string): boolean;
	/**
	 * Build a context fragment for the given agent spec and base context.
	 */
	build(spec: AgentSpecLike, base: BuildContext): Promise<ContextFragment>;
}

// ============================================================================
// ContextPipeline
// ============================================================================

/**
 * Assembles agent context from registered sources.
 *
 * Usage:
 * ```ts
 * const pipeline = new ContextPipeline();
 * pipeline.register(new RoleSource(roleAssetManager));
 * pipeline.register(new ProfileSource(profileRegistry));
 * // ... register more sources ...
 *
 * const assembled = await pipeline.assemble(spec, phaseInfo, buildCtx);
 * const transformCtx = pipeline.toTransformContext(assembled);
 * ```
 */
export class ContextPipeline {
	#sources: ContextSource[] = [];
	#hookPipeline: HookPipeline | undefined;

	constructor(hookPipeline?: HookPipeline) {
		this.#hookPipeline = hookPipeline;
	}

	/**
	 * Register a context source. Sources are sorted by priority on assemble.
	 */
	register(source: ContextSource): void {
		this.#sources.push(source);
	}

	/**
	 * Assemble context by running all applicable sources in priority order.
	 *
	 * 1. Filters sources by `appliesTo(phase, agentRole)`.
	 * 2. Sorts remaining sources by priority (ascending).
	 * 3. Runs each source's `build()` sequentially.
	 * 4. Merges all fragments into an AssembledContext.
	 *
	 * If a source throws, the error is logged and the source is skipped —
	 * one failing source does not crash the pipeline.
	 */
	async assemble(spec: AgentSpecLike, phase: PhaseInfo, base: BuildContext): Promise<AssembledContext> {
		const applicable = this.#sources
			.filter(s => s.appliesTo(phase.phase, spec.role))
			.sort((a, b) => a.priority - b.priority);

		const assembled: AssembledContext = {
			systemPrompt: "",
			taskPrompt: base.taskDescription,
			tools: [],
			injectedMessages: [],
			metadata: {},
		};

		for (const source of applicable) {
			try {
				const fragment = await source.build(spec, {
					...base,
					accumulated: { ...assembled },
				});

				if (fragment.systemPromptAddition) {
					assembled.systemPrompt = assembled.systemPrompt
						? `${assembled.systemPrompt}\n${fragment.systemPromptAddition}`
						: fragment.systemPromptAddition;
				}
				if (fragment.taskPromptAddition) {
					assembled.taskPrompt = assembled.taskPrompt
						? `${assembled.taskPrompt}\n${fragment.taskPromptAddition}`
						: fragment.taskPromptAddition;
				}
				if (fragment.tools && fragment.tools.length > 0) {
					for (const tool of fragment.tools) {
						if (!assembled.tools.includes(tool)) {
							assembled.tools.push(tool);
						}
					}
				}
				if (fragment.injectedMessages && fragment.injectedMessages.length > 0) {
					assembled.injectedMessages.push(...fragment.injectedMessages);
				}

				// Track metadata for debugging
				const additions: string[] = [];
				if (fragment.systemPromptAddition) additions.push("systemPrompt");
				if (fragment.taskPromptAddition) additions.push("taskPrompt");
				if (fragment.tools?.length) additions.push(`tools(${fragment.tools.length})`);
				if (fragment.injectedMessages?.length) additions.push(`messages(${fragment.injectedMessages.length})`);
				assembled.metadata[source.name] = additions.length > 0 ? additions.join(", ") : "(no additions)";
			} catch (err) {
				logger.warn(`[ContextPipeline] Source "${source.name}" failed, skipping`, {
					error: String(err),
					agentId: spec.id,
					phase: phase.phase,
				});
				assembled.metadata[source.name] = `ERROR: ${String(err)}`;
			}
		}

		return assembled;
	}

	/**
	 * Convert assembled context into an AgentLoopConfig["transformContext"] implementation.
	 *
	 * The returned function prepends `assembled.injectedMessages` to the message array,
	 * so external context (experience, stigmergy, etc.) is visible to the agent.
	 *
	 * This is the key integration point with SatoPi's agent loop.
	 */
	toTransformContext(
		assembled: AssembledContext,
		opts?: { compactWindow?: number; agentId?: string },
	): Exclude<AgentLoopConfig["transformContext"], undefined> {
		const injected = assembled.injectedMessages;
		const hookPipeline = this.#hookPipeline;
		const agentId = opts?.agentId;
		return async (messages: AgentMessage[], _signal?: AbortSignal): Promise<AgentMessage[]> => {
			// Hook: context:beforeInjection
			if (hookPipeline) {
				const ctx: HookContext = { phase: undefined, agentId };
				await hookPipeline.trigger("context:beforeInjection", { agentId }, ctx);
			}

			let result = injected.length === 0 ? messages : [...injected, ...messages];

			// Hook: context:afterInjection
			if (hookPipeline) {
				const ctx: HookContext = { phase: undefined, agentId };
				await hookPipeline.trigger("context:afterInjection", { agentId }, ctx);
			}

			// L3 compact context if configured
			if (opts?.compactWindow) {
				// Hook: context:beforeCompaction
				if (hookPipeline) {
					const ctx: HookContext = { phase: undefined, agentId };
					await hookPipeline.trigger("context:beforeCompaction", { agentId }, ctx);
				}

				const compacted = compactContext(result, new Map(), {
					...DEFAULT_COMPACT_CONFIG,
					contextWindow: opts.compactWindow,
				});
				result = compacted.messages;

				// Hook: context:afterCompaction
				if (hookPipeline) {
					const ctx: HookContext = { phase: undefined, agentId };
					await hookPipeline.trigger("context:afterCompaction", { agentId }, ctx);
				}
			}
			return result;
		};
	}

	/**
	 * Get registered sources for debugging.
	 */
	listSources(): ReadonlyArray<{ name: string; priority: number }> {
		return this.#sources.map(s => ({ name: s.name, priority: s.priority })).sort((a, b) => a.priority - b.priority);
	}
}
