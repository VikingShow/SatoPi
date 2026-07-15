/**
 * LoopController — In Loop 循环编排引擎。
 *
 * 继承 PipelineController，注入三个 hook 点：
 *   1. pre-iteration:   Merlin 分析复杂度 → 召唤骑士 → 圆桌自组织分派
 *   2. post-wave:       收集骑士产出物 → 涌现观测
 *   3. review-gate:     动态审查议会 → 判定是否继续迭代 / 上报人类
 */

import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import type { SwarmDefinition, LoopSwarmConfig } from "./schema";
import { PipelineController, type PipelineOptions, type PipelineResult } from "./pipeline";
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
	#modelRegistry?: ModelRegistry;
	#settings?: Settings;
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
		this.#modelRegistry = options.modelRegistry;
		this.#settings = options.settings;
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
				this.#onReview?.({ passed: true, atroposApproved: true, approvalCount: 0, totalCount: 0, findings: [] }, report);
			}

			// ---------------------------------------------------------------
			// Hook Point 3: REVIEW-GATE — 动态审查议会
			// ---------------------------------------------------------------
			const verdict = await this.#reviewGate(iter, options.workspace, this.#modelRegistry, this.#settings);
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
		await this.stateTracker.appendOrchestratorLog(
			`Roundtable verdict: ${result.verdict} (${result.approvalRate * 100}% approval)`,
		);
	}

	// -------------------------------------------------------------------
	// Review gate: assemble council, run review, tally verdict
	// -------------------------------------------------------------------
	async #reviewGate(
		iteration: number,
		workspace: string,
		modelRegistry?: ModelRegistry,
		settings?: Settings,
	): Promise<ReviewVerdict> {
		const { reviewers: reviewersConfig } = this.#loopConfig;
		const reviewerIds = [
			...reviewersConfig.core,
			...reviewersConfig.pool.slice(0, reviewersConfig.maxOptional),
		];

		const findings: string[] = [];
		let atroposApproved = true;
		let approvalCount = 0;
		let totalCount = 0;

		for (const reviewerId of reviewerIds) {
			const reviewerAgent = this.def.agents.get(reviewerId);
			if (!reviewerAgent) continue;

			const reviewPrompt = [
				`You are ${reviewerAgent.role}`,
				`Review the output in the workspace and evaluate its quality.`,
				`Return a single JSON line with your verdict:`,
				`{"verdict":"PASS"|"FAIL","confidence":0.0-1.0,"findings":["summary"]}`,
			].join("\n");

			try {
				const result = await runSubprocess({
					cwd: workspace,
					agent: {
						name: reviewerId,
						description: `Reviewer: ${reviewerAgent.role}`,
						systemPrompt: reviewPrompt,
						source: "project",
						model: reviewerAgent.model ? [reviewerAgent.model] : undefined,
					},
					task: `Review iteration ${iteration + 1} output in the workspace for quality and completeness.`,
					index: totalCount,
					id: `review-${reviewerId}-${iteration}`,
					modelOverride: reviewerAgent.model,
					modelRegistry,
					settings,
				});

				totalCount++;
				const verdict = extractVerdict(reviewerId, result.output);
				if (verdict) {
					findings.push(...verdict.findings);
					if (verdict.passed) approvalCount++;
					if (reviewerId === "atropos" && !verdict.passed) {
						atroposApproved = false;
						findings.push(`[ATROPOS VETO] ${verdict.findings.join("; ")}`);
					}
				}
			} catch (err) {
				findings.push(`Reviewer ${reviewerId} failed: ${String(err)}`);
				totalCount++;
			}
		}

		const passed = atroposApproved && (totalCount === 0 || approvalCount >= Math.ceil(totalCount / 2));

		return {
			passed,
			atroposApproved,
			approvalCount,
			totalCount,
			findings,
		};
	}
}

// ============================================================================
// Factory — wires LoopController with core runtime dependencies
// ============================================================================


export interface CreateLoopOptions {
	loopConfig: LoopSwarmConfig;
	workspace: string;
	onRoundtable?: (result: RoundtableResult) => void;
	onReview?: (verdict: ReviewVerdict, emergence: EmergenceReport) => void;
}

/**
 * Extract capability tags from a knight's role description.
 * Simple keyword-based extraction — no NLP needed.
 */
function extractCapabilities(role: string): string[] {
	const normalized = role.toLowerCase();
	const tags: string[] = [];
	const patterns: [RegExp, string][] = [
		[/\b(architect\w*|design\w*|pattern\w*)\b/, "architecture"],
		[/\b(cod\w*|implement\w*|develop\w*)\b/, "coding"],
		[/\b(test\w*|reliability|ci\W*cd|pipeline)\b/, "testing"],
		[/\b(explor\w*|discover\w*|investigat\w*)\b/, "exploration"],
		[/\b(secur\w*|audit|vulnerab\w*|complian\w*)\b/, "security"],
		[/\b(integrat\w*|api|rpc|contract\w*|cross\W*domain|communicat\w*)\b/, "integration"],
		[/\b(database\w*|infrastructure|migration|config)\b/, "infrastructure"],
		[/\b(perform\w*|optimiz\w*|profil\w*|bottleneck)\b/, "performance"],
		[/\b(document\w*|docs|ux|accessib\w*|a11y|i18n)\b/, "documentation"],
		[/\b(refactor\w*|cleanup|debt|maintain\w*)\b/, "refactoring"],
		[/\b(benchmark\w*|data\W*driven|measur\w*|analys\w*)\b/, "analysis"],
		[/\b(concurren\w*|async|race\W*condition)\b/, "concurrency"],
		[/\b(prototyp\w*|rapid|validat\w*)\b/, "prototyping"],
	];
	for (const [re, tag] of patterns) {
		if (re.test(normalized)) tags.push(tag);
	}
	// Fallback: use the first meaningful word
	if (tags.length === 0) {
		const word = normalized.match(/\b[a-z]{4,}\b/)?.[0];
		if (word) tags.push(word);
	}
	return [...new Set(tags)];
}

/**
 * Create a fully-wired LoopController from a swarm definition.
 *
 * Handles all internal dependency resolution (IrcBus, MAIN_AGENT_ID,
 * knight capabilities, task items) so extensions don't import core internals.
 */
export function createLoopController(
	def: SwarmDefinition,
	waves: string[][],
	stateTracker: StateTracker,
	options: CreateLoopOptions,
): LoopController {
	// 1. Resolve runtime dependencies from the core runtime
	const ircBus = IrcBus.global();
	const merlinAgentId = MAIN_AGENT_ID;

	// 2. Build knight capabilities from the swarm agent definitions
	const knights: KnightCapability[] = [];
	for (const [name, agent] of def.agents) {
		knights.push({
			id: name,
			capabilities: extractCapabilities(agent.role),
			confidence: 0.8,
		});
	}

	// 3. Build task items from the swarm agent task definitions
	const tasks: TaskItem[] = [];
	let priority = 2;
	for (const [name, agent] of def.agents) {
		tasks.push({
			id: name,
			description: agent.task,
			tags: extractCapabilities(agent.role),
			priority,
		});
	}

	return new LoopController(def, waves, stateTracker, {
		loopConfig: options.loopConfig,
		workspace: options.workspace,
		ircBus,
		merlinAgentId,
		knights: knights.length > 0 ? knights : undefined,
		tasks: tasks.length > 0 ? tasks : undefined,
		onRoundtable: options.onRoundtable,
		onReview: options.onReview,
	});
}

// ============================================================================
// Helpers
// ============================================================================

interface ParsedVerdict {
	passed: boolean;
	findings: string[];
	confidence: number;
}

function extractVerdict(reviewerId: string, text: string): ParsedVerdict | null {
	// Try to extract a JSON verdict line from the output
	const jsonMatch = text.match(/\{[^}]*"verdict"[^}]*\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]) as { verdict: string; confidence: number; findings: string | string[] };
			const findingsArr = Array.isArray(parsed.findings) ? parsed.findings : [parsed.findings ?? ""];
			return {
				passed: parsed.verdict === "PASS",
				findings: findingsArr,
				confidence: parsed.confidence ?? 0.5,
			};
		} catch {
			// fall through to heuristic
		}
	}

	// Heuristic: check for FAIL keywords
	const hasFail = /\b(?:FAIL|REJECT[^"]*?)\b/.test(text) && !/\bPASS\b/.test(text);
	if (hasFail) {
		return { passed: false, findings: [`${reviewerId}: ${text.slice(0, 200)}`], confidence: 0.5 };
	}

	return null;
}
