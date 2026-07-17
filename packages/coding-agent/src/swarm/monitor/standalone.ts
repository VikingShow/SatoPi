/**
 * Standalone MonitorServer — real swarm backend with REST API + SSE.
 *
 * Bootstraps auth, ModelRegistry, and Settings (same as the CLI).
 * Exposes start/stop endpoints to launch real LoopController runs.
 *
 * Usage: bun run src/swarm/monitor/standalone.ts [workspace-dir]
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { StateTracker } from "../state";
import { MonitorServer } from "./server";
import { ActivityLogger } from "../activity-logger";
import type { RunManager, SteeringSink } from "./api-routes";
import { parseSwarmYaml, validateSwarmDefinition } from "../schema";
import { createLoopController } from "../loop-controller";
import { discoverAuthStorage } from "../../sdk";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { stampAndArchivePlanMd, archivePlanForHistory } from "../before-loop";
import { BeforeLoopManager } from "../before-loop-manager";
import {
  ExperienceStore,
  extractLessons,
  reflectDeep,
  reflectionToLesson,
  generateRunSummary,
} from "../after-loop";
import type { ExtractedLesson } from "../after-loop";
import type { LoopResult } from "../loop-controller";
import { VerificationHook } from "../verification-hook";
import type { LoopSwarmConfig } from "../schema";

// ============================================================================
// Shared types — used by both backend API and frontend
// ============================================================================

export interface AfterLoopResult {
  runId: string;
  status: string;
  iterations: number;
  summaryMarkdown: string;
  lessons: ExtractedLesson[];
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
    workerCount: number;
    clonerCount: number;
  };
}

// -- Workspace setup -------------------------------------------------------

const WORKSPACE_DIR = path.resolve(process.argv[2] ?? process.cwd(), ".swarm-workspace");
const SWARM_NAME = "demo-swarm";
const YAML_PATH = path.join(WORKSPACE_DIR, "loop.yaml");

const DEFAULT_YAML = `swarm:
  name: demo-swarm
  workspace: .
  mode: loop
  target_count: 1
  model: deepseek-chat
  max_iterations: 5
  auto_retry: true
  human_escalation: true

  workers:
    initial: 3
    min: 1
    max: 10
    max_rounds: 5
    rounds_convergence_threshold: 3

  cloners:
    count: 2

  reviewer:
    enabled: true

  debate:
    enabled: true
    max_rounds: 2

  plan_debate:
    enabled: true
    cloner_count: 2
    max_rounds: 3
`;

// -- RunManager implementation ---------------------------------------------

class SwarmRunManager implements RunManager {
	#loopController: ReturnType<typeof createLoopController> | null = null;
	#abortController: AbortController | null = null;
	#modelRegistry: ModelRegistry;
	#settings: Settings;
	#workspace: string;
	#yamlPath: string;
	#stateTracker: StateTracker;
	#activityLogger: ActivityLogger;
	#experienceStore: ExperienceStore;
	#running = false;
	#lastAfterLoopResult: AfterLoopResult | null = null;
	#loopConfig: LoopSwarmConfig | null = null;

	constructor(opts: {
		modelRegistry: ModelRegistry;
		settings: Settings;
		workspace: string;
		yamlPath: string;
		stateTracker: StateTracker;
		activityLogger: ActivityLogger;
		experienceStore: ExperienceStore;
	}) {
		this.#modelRegistry = opts.modelRegistry;
		this.#settings = opts.settings;
		this.#workspace = opts.workspace;
		this.#yamlPath = opts.yamlPath;
		this.#stateTracker = opts.stateTracker;
		this.#activityLogger = opts.activityLogger;
		this.#experienceStore = opts.experienceStore;
	}

	get isRunning(): boolean {
		return this.#running;
	}

	getLastAfterLoopResult(): AfterLoopResult | null {
		return this.#lastAfterLoopResult;
	}

	async start(): Promise<{ success: boolean; error?: string }> {
		try {
			const content = await fs.readFile(this.#yamlPath, "utf-8");
			const def = parseSwarmYaml(content);
			const errors = validateSwarmDefinition(def);
			if (errors.length > 0) {
				return { success: false, error: errors.join("; ") };
			}

		if (!def.loopConfig) {
			return { success: false, error: "Swarm is not in loop mode" };
		}

		// Cache loop config for verification hook in After Loop pipeline
		this.#loopConfig = def.loopConfig;

			// ── Update loopPhase → running ──
			await this.#stateTracker.updatePipeline({ loopPhase: "running", status: "running" });
			this.#activityLogger.logPhase("loop-start");

			// ── Read & stamp plan.md ──
			// Check if plan.md exists in any of the candidate locations
			const planCandidates = [
				path.join(this.#workspace, ".omp", "plan.md"),
				path.join(this.#workspace, "plan.md"),
			];
			let planPath: string | null = null;
			for (const p of planCandidates) {
				try {
					await fs.access(p);
					planPath = p;
					break;
				} catch {
					// not found, try next
				}
			}

			let planContent: string | undefined;
			if (planPath) {
				// Stamp the plan with a generation timestamp (for tracking)
				// stampAndArchivePlanMd writes the stamped version back to .omp/plan.md
				try {
					planContent = await stampAndArchivePlanMd(this.#workspace);
					console.log(`[RunManager] plan.md loaded and stamped (${planContent.length} chars)`);
				} catch (stampErr) {
					// Fallback: read raw content without stamping
					planContent = await fs.readFile(planPath, "utf-8");
					console.log(`[RunManager] plan.md loaded (unstamped fallback: ${planContent.length} chars)`);
				}
			} else {
				console.warn("[RunManager] WARNING: No plan.md found — workers will run without a plan");
			}

			// Re-init state tracker with parsed agents
			const agentNames = [...def.agents.keys()];
			await this.#stateTracker.init(agentNames, def.targetCount, def.mode);
			// Re-set loopPhase after init (init resets some fields)
			await this.#stateTracker.updatePipeline({ loopPhase: "running", status: "running" });

			// Create loop controller with activity logger
			this.#loopController = createLoopController(this.#stateTracker, {
				loopConfig: def.loopConfig,
				workspace: this.#workspace,
				activityLogger: this.#activityLogger,
			});

			this.#abortController = new AbortController();
			this.#running = true;

			console.log(`[RunManager] Starting swarm "${def.name}" with ${agentNames.length} agents...`);

			// Run loop in background (non-blocking)
			this.#loopController
				.runLoop({
					workspace: this.#workspace,
					modelRegistry: this.#modelRegistry,
					settings: this.#settings,
					signal: this.#abortController.signal,
					planContent,
				})
				.then(async (result) => {
					console.log(`[RunManager] Loop finished: ${result.status}, iterations=${result.iterations}`);
					if (result.errors.length > 0) {
						console.log(`[RunManager] Errors: ${result.errors.join(", ")}`);
					}
					// ── After Loop pipeline ──
					await this.#runAfterLoopPipeline(result);
				})
				.catch((err) => {
					console.error(`[RunManager] Loop failed:`, err);
				})
				.finally(() => {
					this.#running = false;
					this.#loopController = null;
					this.#abortController = null;
				});

			return { success: true };
		} catch (err) {
			return { success: false, error: String(err) };
		}
	}

	async stop(): Promise<{ success: boolean; error?: string }> {
		if (!this.#running) {
			return { success: false, error: "No run in progress" };
		}
		try {
			this.#abortController?.abort();
			this.#running = false;
			console.log("[RunManager] Stop signal sent");
			return { success: true };
		} catch (err) {
			return { success: false, error: String(err) };
		}
	}

	// ────────────────────────────────────────────────────────────────────────
	// After Loop pipeline: extract lessons → deep reflection → save → summarize → archive
	// ────────────────────────────────────────────────────────────────────────
	async #runAfterLoopPipeline(result: LoopResult): Promise<void> {
		const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
		console.log(`[RunManager] After Loop pipeline starting (runId=${runId})...`);

		// ── Verification hook (before After Loop) ──
		// If verification is configured and the LoopResult doesn't already carry
		// verification results (e.g. loop ended via abort/failure), run it here.
		// On blocking failure, return to running instead of entering After Loop.
		if (this.#loopConfig?.verification?.commands?.length) {
			let vResult = result.verificationResults;
			if (!vResult) {
				const hook = new VerificationHook(this.#workspace, this.#activityLogger);
				vResult = await hook.run(this.#loopConfig.verification.commands);
				result.verificationResults = vResult;
			}
			if (!vResult.passed && this.#loopConfig.verification.blocking) {
				console.log("[RunManager] Verification failed (blocking) — returning to running");
				this.#activityLogger.logBroadcast(
					"system",
					"[verification] Blocking failure — returning to running for another iteration",
				);
				// Restart the loop instead of entering After Loop
				await this.#stateTracker.updatePipeline({ loopPhase: "running", status: "running", roundtablePhase: "Verification failed — re-running" });
				this.#activityLogger.logPhase("loop-start");
				try {
					const restartResult = await this.#loopController!.runLoop({
						workspace: this.#workspace,
						modelRegistry: this.#modelRegistry,
						settings: this.#settings,
						signal: this.#abortController?.signal,
					});
					await this.#runAfterLoopPipeline(restartResult);
				} catch (err) {
					console.error("[RunManager] Verification restart loop failed:", err);
				}
				return;
			}
		}

		try {
			// 1. Update pipeline state → after-loop phase
			await this.#stateTracker.updatePipeline({ roundtablePhase: "After Loop: extracting lessons", loopPhase: "after-loop" });
			this.#activityLogger.logPhase("after-loop", undefined, result.iterations);

			// 2. Count workers and cloners from state
			const agents = this.#stateTracker.state.agents;
			const workerCount = Object.values(agents).filter(a => a.name.startsWith("worker")).length;
			const clonerCount = Object.values(agents).filter(a => a.name.startsWith("cloner")).length;

			// 3. Extract lessons (rule-based)
			const extraction = extractLessons(result, workerCount, clonerCount);
			console.log(`[RunManager] Extracted ${extraction.lessons.length} lessons`);

			await this.#stateTracker.updatePipeline({ roundtablePhase: "After Loop: deep reflection" });

			// 4. Deep reflection (LLM-based, best-effort)
			let reflection = null;
			try {
				reflection = await reflectDeep(result, extraction, {
					registry: this.#modelRegistry,
					settings: this.#settings,
				});
				if (reflection) {
					console.log(`[RunManager] Deep reflection completed (confidence: ${reflection.confidence})`);
					// Add reflection as a lesson
					const reflectionLesson = reflectionToLesson(reflection, runId);
					extraction.lessons.push(reflectionLesson);
				} else {
					console.log("[RunManager] Deep reflection returned null (skipped)");
				}
			} catch (reflectErr) {
				console.warn("[RunManager] Deep reflection failed:", reflectErr);
			}

			await this.#stateTracker.updatePipeline({ roundtablePhase: "After Loop: saving experience" });

			// 5. Save all lessons to ExperienceStore
			const referencedRunIds: string[] = [];
			for (const lesson of extraction.lessons) {
				const entry = {
					runId: `${runId}-${lesson.type}`,
					timestamp: new Date().toISOString(),
					lesson,
					stats: extraction.stats,
					weight: 1.0,
				};
				this.#experienceStore.saveLesson(entry);
				referencedRunIds.push(entry.runId);
			}
			console.log(`[RunManager] Saved ${extraction.lessons.length} lessons to ExperienceStore`);

			// 6. Generate run summary
			const summary = generateRunSummary(runId, extraction);
			await this.#experienceStore.writeSummary(runId, summary.markdown);
			console.log(`[RunManager] Summary written to .omp/experience/summaries/${runId}.md`);

			// 7. Archive plan.md for history
			await this.#stateTracker.updatePipeline({ roundtablePhase: "After Loop: archiving plan" });
			try {
				await archivePlanForHistory(this.#workspace);
				console.log("[RunManager] plan.md archived to .omp/plans/");
			} catch (archiveErr) {
				console.warn("[RunManager] Plan archival failed:", archiveErr);
			}

			// 8. Decay unreferenced lessons
			this.#experienceStore.decayUnreferenced(referencedRunIds);

			// 9. Build and store AfterLoopResult for API access
			this.#lastAfterLoopResult = {
				runId,
				status: result.status,
				iterations: result.iterations,
				summaryMarkdown: summary.markdown,
				lessons: extraction.lessons,
				reflection: reflection ? {
					rootCauses: reflection.rootCauses,
					effectivePatterns: reflection.effectivePatterns,
					structuralIssues: reflection.structuralIssues,
					recommendations: reflection.recommendations,
					confidence: reflection.confidence,
				} : null,
				stats: {
					totalIterations: extraction.stats.totalIterations,
					finalStatus: extraction.stats.finalStatus,
					clonerApprovalRatio: extraction.stats.clonerApprovalRatio,
					workerCount: extraction.stats.workerCount,
					clonerCount: extraction.stats.clonerCount,
				},
			};

			// 10. Update pipeline state to completed → idle
			await this.#stateTracker.updatePipeline({ roundtablePhase: "After Loop completed", loopPhase: "idle", status: "completed" });
			this.#activityLogger.logPhase("after-loop-done", undefined, result.iterations);

			console.log("[RunManager] After Loop pipeline completed successfully");
		} catch (afterLoopErr) {
			console.error("[RunManager] After Loop pipeline failed:", afterLoopErr);
			await this.#stateTracker.updatePipeline({ roundtablePhase: "After Loop failed", loopPhase: "idle", status: "failed" });
		}
	}
}

// -- Main -------------------------------------------------------------------

async function main() {
	// 1. Prepare workspace
	await fs.mkdir(WORKSPACE_DIR, { recursive: true });
	const swarmDir = path.join(WORKSPACE_DIR, `.swarm_${SWARM_NAME}`);
	await fs.mkdir(swarmDir, { recursive: true });

	// Write default YAML if not exists
	try {
		await fs.access(YAML_PATH);
	} catch {
		await fs.writeFile(YAML_PATH, DEFAULT_YAML, "utf-8");
	}

	// 2. Bootstrap auth + model registry + settings
	console.log("Bootstrapping auth and model registry...");
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	const settings = Settings.isolated();

	// 3. Create StateTracker (idle — no agents until a run starts)
	const stateTracker = new StateTracker(WORKSPACE_DIR, SWARM_NAME);

	// 4. Create ActivityLogger
	const activityLogger = new ActivityLogger(stateTracker.swarmDir);

	// 4b. Create and initialize ExperienceStore
	console.log("Initializing ExperienceStore...");
	const experienceStore = new ExperienceStore(WORKSPACE_DIR);
	await experienceStore.init();

	// 5. Create RunManager
	const runManager = new SwarmRunManager({
		modelRegistry,
		settings,
		workspace: WORKSPACE_DIR,
		yamlPath: YAML_PATH,
		stateTracker,
		activityLogger,
		experienceStore,
	});

	// 5b. Create BeforeLoopManager (shares same modelRegistry, settings, stateTracker, etc.)
	const beforeLoopManager = new BeforeLoopManager({
		modelRegistry,
		settings,
		workspace: WORKSPACE_DIR,
		yamlPath: YAML_PATH,
		stateTracker,
		activityLogger,
		experienceStore,
		runManager,
	});

	// 5c. Create SteeringSink — logs operator steering messages via ActivityLogger → SSE
	const steeringSink: SteeringSink = {
		steer(text: string): void {
			activityLogger.logSteering("operator", "all", text);
		},
	};

	// 6. Create and start MonitorServer (with runManager + beforeLoopManager + steeringSink injected)
	const server = new MonitorServer(stateTracker, WORKSPACE_DIR, YAML_PATH, runManager, experienceStore, beforeLoopManager, steeringSink);
	const port = server.start(7878);

	// 7. Wire ActivityLogger → SSE
	activityLogger.setBroadcaster(server);

	console.log(`\n┌──────────────────────────────────────────────────┐`);
	console.log(`│  SatoPi MonitorServer (real swarm backend)       │`);
	console.log(`│  API:   http://127.0.0.1:${String(port).padEnd(24)}│`);
	console.log(`│  SSE:   http://127.0.0.1:${port}/events            │`);
	console.log(`│  YAML:  ${YAML_PATH.slice(0, 37).padEnd(37)}│`);
	console.log(`│  POST /api/run/start  → launch swarm             │`);
	console.log(`│  POST /api/run/stop   → abort swarm              │`);
	console.log(`│  GET  /api/after-loop/summary → last run result  │`);
	console.log(`│  GET  /api/experience?q=...   → search lessons    │`);
	console.log(`└──────────────────────────────────────────────────┘\n`);

	// Graceful shutdown
	const shutdown = () => {
		console.log("\nShutting down MonitorServer...");
		if (runManager.isRunning) {
			runManager.stop().catch(() => {});
		}
		server.stop();
		experienceStore.close();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

main().catch((err) => {
	console.error("Failed to start MonitorServer:", err);
	process.exit(1);
});
