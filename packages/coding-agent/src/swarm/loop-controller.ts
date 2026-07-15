/**
 * LoopController — In Loop 循环编排引擎。
 *
 * 继承 PipelineController，注入三个 hook 点：
 *   1. pre-iteration:   Merlin 分析复杂度 → 召唤骑士 → 圆桌自组织分派
 *   2. post-wave:       收集骑士产出物 → 涌现观测
 *   3. review-gate:     动态审查议会 → 判定是否继续迭代 / 上报人类
 */

import type { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { PipelineController, type PipelineOptions, type PipelineResult, type PipelineProgress } from "./pipeline";
import type { SwarmDefinition, LoopSwarmConfig } from "./schema";
import type { StateTracker } from "./state";
import { RoundtableOrchestrator, type RoundtableResult } from "./roundtable";
import { BidAssigner, type KnightCapability, type TaskItem, type EmergenceReport } from "./bid-assigner";

// ============================================================================
// Loop types
// ============================================================================

export interface LoopOptions extends PipelineOptions {
	loopConfig: LoopSwarmConfig;
	ircBus?: IrcBus;
	merlinAgentId?: string; // Cloner 的 agent id
	knights?: KnightCapability[]; // 本次召唤的骑士能力列表
	tasks?: TaskItem[]; // 任务清单
	onRoundtable?: (result: RoundtableResult) => void;
	onReview?: (verdict: ReviewVerdict, emergence: EmergenceReport) => void;
}

export interface ReviewVerdict {
	passed: boolean;
	atroposApproved: boolean;
	approvalCount: number;
	totalCount: number;
	findings: string[];
}

export interface LoopResult {
	status: "completed" | "failed" | "aborted" | "escalated";
	iterations: number;
	reviewVerdicts: ReviewVerdict[];
	emergenceReports: EmergenceReport[];
	errors: string[];
}

// ============================================================================
// Controller
// ============================================================================

export class LoopController extends PipelineController {
	readonly #loopConfig: LoopSwarmConfig;
	readonly #ircBus?: IrcBus;
	readonly #merlinId?: string;
	readonly #knights?: KnightCapability[];
	readonly #tasks?: TaskItem[];
	readonly #onRoundtable?: (result: RoundtableResult) => void;
	readonly #onReview?: (verdict: ReviewVerdict, emergence: EmergenceReport) => void;

	constructor(
		def: SwarmDefinition,
		waves: string[][],
		stateTracker: StateTracker,
		options: LoopOptions,
	) {
		super(def, waves, stateTracker);
		this.#loopConfig = options.loopConfig;
		this.#ircBus = options.ircBus;
		this.#merlinId = options.merlinAgentId;
		this.#knights = options.knights;
		this.#tasks = options.tasks;
		this.#onRoundtable = options.onRoundtable;
		this.#onReview = options.onReview;
	}

	async runLoop(options: PipelineOptions): Promise<LoopResult> {
		const verdicts: ReviewVerdict[] = [];
		const emergences: EmergenceReport[] = [];
		const errors: string[] = [];

		for (let iter = 0; iter < this.#loopConfig.maxIterations; iter++) {
			if (options.signal?.aborted) {
				return { status: "aborted", iterations: iter, reviewVerdicts: verdicts, emergenceReports: emergences, errors };
			}

			options.onProgress?.({
				iteration: iter,
				targetCount: this.#loopConfig.maxIterations,
				currentWave: 0,
				totalWaves: 1,
				agents: {},
			});

			// ---------------------------------------------------------------
			// Hook Point 1: PRE-ITERATION — 圆桌自组织分派
			// ---------------------------------------------------------------
			if (iter === 0 && this.#ircBus && this.#merlinId && this.#knights) {
				await this.#runRoundtableAssignment(options);
			}

			// ---------------------------------------------------------------
			// Hook Point 2: WAVE EXECUTION — 骑士执行任务
			// ---------------------------------------------------------------
			const pipelineResult: PipelineResult = await super.run({
				...options,
				onProgress: undefined, // loop uses its own progress
			});

			if (pipelineResult.status !== "completed") {
				errors.push(...pipelineResult.errors);
				if (pipelineResult.status === "aborted") {
					return { status: "aborted", iterations: iter + 1, reviewVerdicts: verdicts, emergenceReports: emergences, errors };
				}
			}

			// ---------------------------------------------------------------
			// Emergence observation
			// ---------------------------------------------------------------
			if (this.#knights && this.#tasks) {
				const assigner = new BidAssigner();
				const result = assigner.assign(this.#knights, this.#tasks);
				const report = assigner.observeEmergence(result, this.#knights, this.#tasks);
				emergences.push(report);
				this.#onReview?.(this.#buildFauxVerdict(), report);
			}

			// ---------------------------------------------------------------
			// Hook Point 3: REVIEW-GATE — 动态审查议会
			// ---------------------------------------------------------------
			const verdict = await this.#reviewGate(iter);
			verdicts.push(verdict);

			if (verdict.passed) break;

			if (iter === this.#loopConfig.maxIterations - 1 && this.#loopConfig.humanEscalation) {
				return {
					status: "escalated",
					iterations: iter + 1,
					reviewVerdicts: verdicts,
					emergenceReports: emergences,
					errors,
				};
			}
		}

		return {
			status: "completed",
			iterations: verdicts.length,
			reviewVerdicts: verdicts,
			emergenceReports: emergences,
			errors,
		};
	}

	// -------------------------------------------------------------------
	// Roundtable: Merlin → knights self-organize
	// -------------------------------------------------------------------
	async #runRoundtableAssignment(options: PipelineOptions): Promise<void> {
		if (!this.#ircBus || !this.#merlinId || !this.#knights || this.#knights.length <= 1) return;

		const knightIds = this.#knights.map((k) => k.id);
		const topic = this.#tasks?.map((t) => `[${t.id}] ${t.description}`).join("\n") ?? "Complete assigned work";

		const orchestrator = new RoundtableOrchestrator(
			this.#ircBus,
			this.#merlinId,
			knightIds,
			topic,
			this.#loopConfig.roundtable,
		);

		const result = await orchestrator.run(options.signal);
		this.#onRoundtable?.(result);

		// If rejected, still proceed (knights may need to re-negotiate through irc)
		await this.#stateTracker?.appendOrchestratorLog(
			`Roundtable verdict: ${result.verdict} (${result.approvalRate * 100}% approval)`,
		);
	}

	// -------------------------------------------------------------------
	// Review gate: assemble council, run review, tally verdict
	// -------------------------------------------------------------------
	async #reviewGate(_iteration: number): Promise<ReviewVerdict> {
		// TODO: Full implementation spawns reviewer agents via task.batch
		// and collects structured verdicts. For now, return a placeholder
		// that marks the iteration as passed so the loop machinery is
		// exercisable.
		return {
			passed: true,
			atroposApproved: true,
			approvalCount: 3,
			totalCount: 3,
			findings: [],
		};
	}

	#buildFauxVerdict(): ReviewVerdict {
		return { passed: true, atroposApproved: true, approvalCount: 0, totalCount: 0, findings: [] };
	}

	get #stateTracker(): StateTracker | undefined {
		// StateTracker is private in PipelineController; we access it via
		// the appendOrchestratorLog method which is public. The concrete
		// tracker reference is not exposed, so roundtable logging uses the
		// public API. If unavailable we silently skip.
		try {
			return (this as unknown as { _stateTracker: StateTracker })._stateTracker;
		} catch {
			return undefined;
		}
	}
}
