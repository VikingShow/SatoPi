/**
 * LoopController — In Loop 循环编排引擎。
 *
 * 编排流程:
 *   Cloner 对话→plan.md → 创建 workers（空白 agent）+ cloners（Cloner 克隆体）
 *   → Workers 群聊自组织分工 → 并行执行
 *   → Cloners 秘密监视 → 圆桌审查 → PASS 或继续迭代
 */

import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import type { PipelineOptions } from "./pipeline";
import type { LoopSwarmConfig } from "./schema";
import type { StateTracker } from "./state";
import { WorkerChannel } from "./worker-channel";
import { ClonerCouncil, type ReviewVerdict } from "./roundtable";

// ============================================================================
// Types
// ============================================================================

export interface LoopOptions extends PipelineOptions {
	loopConfig: LoopSwarmConfig;
	ircBus?: IrcBus;
	clonerAgentId?: string;
	/** plan.md content from the Before Loop phase. Injected into worker + cloner prompts. */
	planContent?: string;
}


export interface LoopResult {
	status: "completed" | "failed" | "aborted" | "escalated";
	iterations: number;
	reviewVerdicts: ReviewVerdict[];
	errors: string[];
}

// ============================================================================
// Prompts
// ============================================================================

const WORKER_SYSTEM_PROMPT = `\
You are a Worker in the Loop Engineering system. You collaborate with other Workers
to complete a task defined in a plan that will be provided.

MECHANISM:
- A Cloner has broadcast a plan.md containing the goal, constraints, and acceptance criteria.
- You and other Workers negotiate via group chat (the WorkerChannel) how to divide the work.
  No one assigns tasks to you — you self-organize through open discussion.
- You can broadcast to all Workers, or create sub-groups for focused collaboration.
- During execution, if you need more or fewer Workers, you can request changes.
- After each round, Cloners review the output and provide feedback.

YOUR CAPABILITIES:
- Full tool access: read, write, edit, bash, grep, glob, web_search, browser
- Communicate with other Workers via irc (use \`irc send\` with to:"worker:*" for broadcast)
- Write output to the workspace directory

BEHAVIOR:
- Proactively negotiate — don't wait to be told what to do.
- If another Worker is duplicating your work, coordinate with them.
- If you're blocked, broadcast for help.
- Record what you did and what you learned.
- Always produce verifiable output in the workspace.`;


// ============================================================================
// Controller
// ============================================================================

export class LoopController {
	readonly #loopConfig: LoopSwarmConfig;
	readonly #ircBus: IrcBus;
	readonly #clonerId: string;
	#channel?: WorkerChannel;

	constructor(options: LoopOptions) {
		this.#loopConfig = options.loopConfig;
		this.#ircBus = options.ircBus ?? IrcBus.global();
		this.#clonerId = options.clonerAgentId ?? MAIN_AGENT_ID;
	}

	async runLoop(options: PipelineOptions & { planContent?: string }): Promise<LoopResult> {
		const verdicts: ReviewVerdict[] = [];
		const errors: string[] = [];
		const clonerFeedbackHistory: string[] = [];
		const { workspace, modelRegistry, settings, signal, planContent } = options;

		const workerCount = this.#loopConfig.workers.initial;
		const clonerCount = this.#loopConfig.cloners.count;

		// Create WorkerChannel
		const workerIds = Array.from({ length: workerCount }, (_, i) => `worker-${i + 1}`);
		const clonerIds = Array.from({ length: clonerCount }, (_, i) => `cloner-${i + 1}`);
		this.#channel = new WorkerChannel(this.#ircBus, {
			workers: workerIds,
			cloners: clonerIds,
		});

		// Broadcast initial plan
		await this.#channel.broadcast(this.#clonerId, `Plan broadcast. Workers: ${workerCount}, Cloners: ${clonerCount}.`);

		for (let iter = 0; iter < this.#loopConfig.maxIterations; iter++) {
			if (signal?.aborted) {
				return {
					status: "aborted",
					iterations: iter,
					reviewVerdicts: verdicts,
					errors,
				};
			}

			options.onProgress?.({
				iteration: iter,
				targetCount: this.#loopConfig.maxIterations,
				currentWave: 0,
				totalWaves: 1,
				agents: Object.fromEntries(workerIds.map((id) => [id, { status: "running", iteration: iter }])),
			});

			// 1. Spawn workers (parallel)
			const workerResults = await this.#spawnWorkers(workerIds, workspace, planContent, clonerFeedbackHistory, modelRegistry, settings, signal);
			if (signal?.aborted) {
				return {
					status: "aborted",
					iterations: iter + 1,
					reviewVerdicts: verdicts,
					errors,
				};
			}

			// 3. Collect worker output for review context
			const workerOutput = workerResults
				.map((r) => `[${r.agent}] ${r.output.slice(0, 4000)}`)
				.join("\n\n---\n\n");

			// 4. Spawn cloners to review (parallel)
			const verdict = await this.#runClonerReview(
				clonerIds,
				iter,
				workerOutput,
				workspace,
				planContent,
				clonerFeedbackHistory,
				modelRegistry,
			);

			if (verdict.passed) {
				return {
					status: "completed",
					iterations: iter + 1,
					reviewVerdicts: verdicts,
					errors,
				};
			}

			// 5. Broadcast feedback and accumulate for cross-iteration memory
			const feedback = verdict.findings.join("\n");
			clonerFeedbackHistory.push(feedback);
			await this.#channel.broadcast(this.#clonerId, `Review feedback (iteration ${iter + 1}):\n${feedback}`);
			if (iter === this.#loopConfig.maxIterations - 1) {
				const status = this.#loopConfig.humanEscalation ? "escalated" : "failed";
				return {
					status,
					iterations: iter + 1,
					reviewVerdicts: verdicts,
					errors,
				};
			}
		}

		return {
			status: "completed",
			iterations: this.#loopConfig.maxIterations,
			reviewVerdicts: verdicts,
			errors,
		};
	}

	// -------------------------------------------------------------------
	// Spawn workers in parallel
	// -------------------------------------------------------------------
	async #spawnWorkers(
		workerIds: string[],
		workspace: string,
		planContent: string | undefined,
		previousFeedback: string[],
		modelRegistry?: ModelRegistry,
		settings?: Settings,
		signal?: AbortSignal,
	): Promise<SingleResult[]> {
		const feedbackBlock = previousFeedback.length > 0
			? `\n## Previous Review Feedback\n\n${previousFeedback.map((f, i) => `(Iteration ${i + 1}) ${f}`).join("\n")}\n`
			: "";

		const results = await Promise.all(
			workerIds.map((id, i) =>
				runSubprocess({
					cwd: workspace,
					agent: {
						name: id,
						description: `Loop Engineering Worker ${i + 1}`,
						systemPrompt: WORKER_SYSTEM_PROMPT,
						source: "project",
					},
					task: [
						`You are Worker ${i + 1} of ${workerIds.length}.`,
						`Your peers are: ${workerIds.filter((w) => w !== id).join(", ")}.`,
						`Negotiate with them via IRC (use \`irc send to:worker:*\` for broadcast).`,
						`Work in the workspace: ${workspace}.`,
						planContent ? `\n## Plan\n\n${planContent}` : "",
						feedbackBlock,
						`\nProduce your output in the workspace directory.`,
					].join("\n"),
					index: i,
					id: `worker-${id}`,
					modelRegistry,
					settings,
					signal,
				}),
			),
		);

		return results;
	}
	// -------------------------------------------------------------------
	// Run cloner review via ClonerCouncil
	// -------------------------------------------------------------------
	async #runClonerReview(
		clonerIds: string[],
		iteration: number,
		workerOutput: string,
		workspace: string,
		planContent: string | undefined,
		previousFindings: string[],
		modelRegistry?: ModelRegistry,
	): Promise<ReviewVerdict> {
		const council = new ClonerCouncil(this.#channel!);
		return council.review({
			clonerIds,
			workspace,
			iteration,
			workerOutput,
			planContent,
			previousFindings,
		}, modelRegistry);
	}
}

// ============================================================================
// Factory — wires LoopController with core runtime dependencies
// ============================================================================

export interface CreateLoopOptions {
	loopConfig: LoopSwarmConfig;
	workspace: string;
}

export function createLoopController(
	stateTracker: StateTracker,
	options: CreateLoopOptions,
): LoopController {
	const ircBus = IrcBus.global();
	const clonerAgentId = MAIN_AGENT_ID;

	return new LoopController({
		loopConfig: options.loopConfig,
		workspace: options.workspace,
		ircBus,
		clonerAgentId,
	});
}

