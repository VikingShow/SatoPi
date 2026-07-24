/**
 * AgentForkManager — Agent 深 Fork + 子任务分配
 *
 * 替换 agent-profile.ts L8 的 Fork 禁令。实现:
 *   - 深 Fork: 从父 Agent 状态克隆出子 Agent 实例
 *   - 子任务分配: LLM 驱动的任务拆分
 *   - 结果收集: Promise.all 等待所有 fork 完成，合并结果
 *   - 深度限制: fork 出的 agent 不可再 fork (depth=1)
 *
 * 架构:
 *   Agent 感知任务过多 → LLM 调用 agent_fork tool
 *     → AgentForkManager.fork(parentAgent, count)
 *       → SubtaskDecomposer.decompose(task, count)
 *       → 对每个子任务创建新 Agent 并 prompt
 *       → Promise.all(children) 等待完成
 *       → 合并结果，steer 回父 Agent
 */

import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AgentState, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";

// ============================================================================
// Types
// ============================================================================

export interface ForkOptions {
	/** Number of child agents to fork */
	count?: number;
	/** Reason for forking (logged) */
	reason?: string;
	/** Maximum fork depth — prevent infinite forking */
	maxDepth?: number;
	/** Current depth (parent = 0, child = 1) */
	depth?: number;
}

export interface ForkResult {
	/** Child agent IDs */
	childIds: string[];
	/** Per-child subtask descriptions */
	subtasks: Map<string, string>;
	/** Merged results from all children */
	mergedOutput: string;
}

export interface ForkableState {
	systemPrompt: string[];
	model: Model;
	tools: AgentTool<any>[];
	messages: AgentMessage[];
}

// ============================================================================
// Fork utility
// ============================================================================

/**
 * Tools that should NOT be inherited by forked children
 * (prevent infinite fork recursion and parent-level operations)
 */
const NON_FORKABLE_TOOLS = new Set([
	"agent_fork",       // prevent fork recursion
	"task",             // prevent spawning from child
	"agent_broadcast",  // children use parent channel
	"agent_roundtable",
]);

/**
 * Extract forkable state from a parent Agent.
 *
 * Since Agent uses #private fields, we read from public getters (agent.state)
 * and recreate via the AgentOptions constructor.
 */
export function extractForkableState(
	agent: Agent,
	options?: { maxMessages?: number },
): ForkableState {
	const state = agent.state;

	// Compress messages: keep system preamble (first 2) + last N messages
	const maxMessages = options?.maxMessages ?? 10;
	let messages: AgentMessage[];
	if (state.messages.length <= maxMessages + 2) {
		messages = state.messages.slice();
	} else {
		const preamble = state.messages.slice(0, 2);
		const tail = state.messages.slice(-maxMessages);
		messages = [...preamble, ...tail];
	}

	// Filter tools
	const tools = (state.tools ?? []).filter(t => !NON_FORKABLE_TOOLS.has(t.name));

	return {
		systemPrompt: state.systemPrompt.slice(),
		model: state.model,
		tools,
		messages,
	};
}

/**
 * Create a forked Agent instance from forkable parent state.
 */
export function createForkedAgent(
	parentState: ForkableState,
	options: {
		childId: string;
		extraSystemPrompt?: string[];
		forkDepth: number;
	},
): Agent {
	const agent = new Agent({
		initialState: {
			systemPrompt: [
				...parentState.systemPrompt,
				...(options.extraSystemPrompt ?? []),
				`[You are agent "${options.childId}", forked at depth ${options.forkDepth}. Report results to your parent. Do NOT attempt to fork further.]`,
			],
			model: parentState.model,
			tools: parentState.tools,
			messages: parentState.messages.slice(),
		},
	});

	return agent;
}

// ============================================================================
// SubtaskDecomposer — LLM 驱动的任务拆分
// ============================================================================

export interface SubtaskDecomposition {
	subtasks: Array<{ id: string; title: string; description: string }>;
}

/**
 * Split a parent task into N subtasks using a lightweight LLM call.
 *
 * In the future this could use a cheap model (e.g., gemini-flash) for the split.
 * Current implementation uses simple text-based heuristics.
 */
export async function decomposeSubtasks(
	taskDescription: string,
	count: number,
): Promise<string[]> {
	// Simple heuristic: split by numbered items or paragraphs
	const parts = taskDescription
		.split(/\n{2,}|(?<=\d)\. /)
		.filter(p => p.trim().length > 0);

	if (parts.length >= count) {
		// Distribute parts across subtasks
		const perChild = Math.ceil(parts.length / count);
		const subtasks: string[] = [];
		for (let i = 0; i < count; i++) {
			const slice = parts.slice(i * perChild, (i + 1) * perChild);
			subtasks.push(slice.join("\n") || `Subtask ${i + 1} of the main task`);
		}
		return subtasks;
	}

	// If can't split naturally, create numbered subtasks
	const subtasks: string[] = [];
	for (let i = 0; i < count; i++) {
		subtasks.push(`[Subtask ${i + 1}/${count}] ${taskDescription}`);
	}
	return subtasks;
}

// ============================================================================
// AgentForkManager
// ============================================================================

export class AgentForkManager {
	#depth = 0;
	readonly #maxDepth: number;
	#children: Map<string, Agent> = new Map();
	#childIds: string[] = [];
	#childCounter = 0;

	constructor(maxDepth: number = 1) {
		this.#maxDepth = maxDepth;
	}

	get depth(): number { return this.#depth; }
	get children(): ReadonlyMap<string, Agent> { return this.#children; }

	/**
	 * Fork parent agent into N child agents.
	 *
	 * @returns ForkResult with child IDs and subtasks
	 */
	async fork(
		parentAgent: Agent,
		taskDescription: string,
		options: ForkOptions = {},
	): Promise<ForkResult> {
		const count = options.count ?? 2;
		const reason = options.reason ?? "Task is too complex";
		const depth = options.depth ?? this.#depth;

		if (depth >= this.#maxDepth) {
			throw new Error(`Cannot fork: max fork depth ${this.#maxDepth} reached (current: ${depth})`);
		}

		logger.info("[AgentForkManager] Forking agent", {
			count, reason, depth, maxDepth: this.#maxDepth,
		});

		// 1. Extract forkable state
		const forkable = extractForkableState(parentAgent);

		// 2. Decompose task
		const subtaskDescriptions = await decomposeSubtasks(taskDescription, count);

		// 3. Create child agents
		const subtasks = new Map<string, string>();
		const children: Agent[] = [];

		for (let i = 0; i < count; i++) {
			const childId = `${parentAgent.state.model.id.split("/").pop()}-fork-${++this.#childCounter}`;
			const subtask = subtaskDescriptions[i] ?? `Subtask ${i + 1}/${count}`;
			subtasks.set(childId, subtask);

			const child = createForkedAgent(forkable, {
				childId,
				extraSystemPrompt: [
					`[Fork Reason: ${reason}]`,
					`[Your subtask]: ${subtask}`,
				],
				forkDepth: depth + 1,
			});

			children.push(child);
			this.#children.set(childId, child);
			this.#childIds.push(childId);

			logger.debug("[AgentForkManager] Created child agent", { childId, subtaskLen: subtask.length });
		}

		// 4. Start all children in parallel
		const prompts = children.map((child, i) => {
			const subtask = subtaskDescriptions[i];
			return child.prompt(`[FORKED TASK] You have been assigned the following subtask:\n\n${subtask}\n\nComplete this subtask thoroughly. When done, report your results.`);
		});

		await Promise.all(prompts);

		return {
			childIds: this.#childIds,
			subtasks,
			mergedOutput: "", // filled by collectResults()
		};
	}

	/**
	 * Wait for all child agents to complete and collect their results.
	 */
	async collectResults(parentAgent: Agent): Promise<ForkResult> {
		// Wait for all children to finish
		const childPromises = [...this.#children.values()].map(child =>
			child.waitForIdle().then(() => child),
		);
		const completedChildren = await Promise.all(childPromises);

		// Collect results: extract last assistant message from each child
		const results: string[] = [];
		const subtasks = new Map<string, string>();

		for (const child of completedChildren) {
			const state = child.state;
			const lastAssistant = [...state.messages]
				.reverse()
				.find(m => m.role === "assistant");

			if (lastAssistant) {
				let text = "";
				if (typeof lastAssistant.content === "string") {
					text = lastAssistant.content;
				} else if (Array.isArray(lastAssistant.content)) {
					text = lastAssistant.content
						.filter(c => c.type === "text")
						.map(c => c.text)
						.join("\n");
				}
				results.push(text);
			}
		}

		const mergedOutput = results
			.map((r, i) => `[Forked Agent Result ${i + 1}]\n${r}`)
			.join("\n\n---\n\n");

		logger.info("[AgentForkManager] All children completed", {
			total: this.#children.size,
			resultsLen: mergedOutput.length,
		});

		return {
			childIds: this.#childIds,
			subtasks,
			mergedOutput,
		};
	}

	/**
	 * Reset fork state (for reuse in a new fork cycle).
	 */
	reset(): void {
		this.#children.clear();
		this.#childIds = [];
		this.#childCounter = 0;
	}
}
