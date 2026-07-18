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
import { logger } from "@oh-my-pi/pi-utils";
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
import { RoleAssetManager } from "../role-asset";

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
const DEFAULT_SWARM_NAME = "SatoPi";
const YAML_PATH = path.join(WORKSPACE_DIR, "loop.yaml");

/** Resolve the swarm name: prefer `swarm.name` in loop.yaml, fall back to "SatoPi". */
async function resolveSwarmName(yamlPath: string): Promise<string> {
	try {
		const content = await fs.readFile(yamlPath, "utf-8");
		const def = parseSwarmYaml(content);
		return def.name || DEFAULT_SWARM_NAME;
	} catch {
		return DEFAULT_SWARM_NAME;
	}
}

const DEFAULT_YAML = `swarm:
  name: SatoPi
  workspace: .
  mode: loop
  target_count: 1
  model: deepseek-v4-pro
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

  agent_restrictions:
    socrates:
      allowed: ["read", "write_file", "grep", "find"]
    cloner:
      blocked: ["bash", "write_file", "edit"]
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
					logger.info("[RunManager] plan.md loaded and stamped", { length: planContent.length });
				} catch (stampErr) {
					// Fallback: read raw content without stamping
					planContent = await fs.readFile(planPath, "utf-8");
					logger.info("[RunManager] plan.md loaded (unstamped fallback)", { length: planContent.length });
				}
			} else {
				logger.warn("[RunManager] No plan.md found — workers will run without a plan");
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

			logger.info("[RunManager] Starting swarm", { name: def.name, agentCount: agentNames.length });

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
					logger.info("[RunManager] Loop finished", { status: result.status, iterations: result.iterations });
					if (result.errors.length > 0) {
						logger.info("[RunManager] Loop errors", { errors: result.errors });
					}
					// ── After Loop pipeline ──
					await this.#runAfterLoopPipeline(result);
				})
				.catch((err) => {
					logger.error("[RunManager] Loop failed", { error: String(err) });
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
			logger.info("[RunManager] Stop signal sent");
			return { success: true };
		} catch (err) {
			return { success: false, error: String(err) };
		}
	}

async pause(): Promise<{ success: boolean; error?: string }> {
		if (!this.#loopController) {
			return { success: false, error: "No loop controller available" };
		}
		try {
			this.#loopController.pause();
			return { success: true };
		} catch (err) {
			return { success: false, error: String(err) };
		}
	}

	async resume(): Promise<{ success: boolean; error?: string }> {
		if (!this.#loopController) {
			return { success: false, error: "No loop controller available" };
		}
		try {
			this.#loopController.resume();
			return { success: true };
		} catch (err) {
			return { success: false, error: String(err) };
		}
	}

	async updatePlanAndContinue(newPlan: string): Promise<{ success: boolean; error?: string }> {
		if (!this.#loopController) {
			return { success: false, error: "No loop controller available" };
		}
		try {
			await this.#loopController.updatePlan(newPlan, this.#workspace);
			// If the loop is paused, resume it so the new plan takes effect.
			this.#loopController.resume();
			return { success: true };
		} catch (err) {
			return { success: false, error: String(err) };
		}
	}

	/** Resolve the current blockage — delegates to LoopController. */
	resolveBlocker(decision: "continue" | "skip" | "abort"): boolean {
		if (!this.#loopController) return false;
		return this.#loopController.resolveBlocker(decision);
	}

	// ────────────────────────────────────────────────────────────────────────
	// After Loop pipeline: extract lessons → deep reflection → save → summarize → archive
	// ────────────────────────────────────────────────────────────────────────
	async #runAfterLoopPipeline(result: LoopResult): Promise<void> {
		const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
		logger.info("[RunManager] After Loop pipeline starting", { runId });

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
				logger.info("[RunManager] Verification failed (blocking) — returning to running");
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
					logger.error("[RunManager] Verification restart loop failed", { error: String(err) });
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
			logger.info("[RunManager] Extracted lessons", { count: extraction.lessons.length });

			await this.#stateTracker.updatePipeline({ roundtablePhase: "After Loop: deep reflection" });

			// 4. Deep reflection (LLM-based, best-effort)
			let reflection = null;
			try {
				reflection = await reflectDeep(result, extraction, {
					registry: this.#modelRegistry,
					settings: this.#settings,
				});
				if (reflection) {
					logger.info("[RunManager] Deep reflection completed", { confidence: reflection.confidence });
					// Add reflection as a lesson
					const reflectionLesson = reflectionToLesson(reflection, runId);
					extraction.lessons.push(reflectionLesson);
				} else {
					logger.info("[RunManager] Deep reflection returned null (skipped)");
				}
			} catch (reflectErr) {
				logger.warn("[RunManager] Deep reflection failed", { error: String(reflectErr) });
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
			logger.info("[RunManager] Saved lessons to ExperienceStore", { count: extraction.lessons.length });

			// 6. Generate run summary
			const summary = generateRunSummary(runId, extraction);
			await this.#experienceStore.writeSummary(runId, summary.markdown);
			logger.info("[RunManager] Summary written", { path: `.omp/experience/summaries/${runId}.md` });

			// 7. Archive plan.md for history
			await this.#stateTracker.updatePipeline({ roundtablePhase: "After Loop: archiving plan" });
			try {
				await archivePlanForHistory(this.#workspace);
				logger.info("[RunManager] plan.md archived to .omp/plans/");
			} catch (archiveErr) {
				logger.warn("[RunManager] Plan archival failed", { error: String(archiveErr) });
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

			logger.info("[RunManager] After Loop pipeline completed successfully");
		} catch (afterLoopErr) {
			logger.error("[RunManager] After Loop pipeline failed", { error: String(afterLoopErr) });
			await this.#stateTracker.updatePipeline({ roundtablePhase: "After Loop failed", loopPhase: "idle", status: "failed" });
		}
	}
}

// -- Main -------------------------------------------------------------------

async function main() {
	// 1. Prepare workspace
	await fs.mkdir(WORKSPACE_DIR, { recursive: true });

	// Write default YAML if not exists
	try {
		await fs.access(YAML_PATH);
	} catch {
		await fs.writeFile(YAML_PATH, DEFAULT_YAML, "utf-8");
	}

	// Resolve the swarm name from YAML (e.g. "SatoPi")
	const swarmName = await resolveSwarmName(YAML_PATH);
	const swarmDir = path.join(WORKSPACE_DIR, `.swarm_${swarmName}`);
	await fs.mkdir(swarmDir, { recursive: true });

	// 2. Bootstrap auth + model registry + settings
	logger.info("Bootstrapping auth and model registry...");
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	const settings = Settings.isolated();

	// 3. Create StateTracker (idle — no agents until a run starts)
	const stateTracker = new StateTracker(WORKSPACE_DIR, swarmName);

	// 4. Create ActivityLogger
	const activityLogger = new ActivityLogger(stateTracker.swarmDir);

	// 4b. Create and initialize ExperienceStore
	logger.info("Initializing ExperienceStore...");
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

	// 5d. Create and initialize RoleAssetManager — seed built-in roles if empty
	logger.info("Initializing RoleAssetManager...");
	const roleAssetManager = new RoleAssetManager(WORKSPACE_DIR);
	await roleAssetManager.init();
	const seeded = await roleAssetManager.seedIfEmpty();
	if (seeded > 0) {
		logger.info(`Seeded ${seeded} built-in role assets`);
	}

	// 6. Create and start MonitorServer (with runManager + beforeLoopManager + steeringSink + modelRegistry + roleAssetManager injected)
	const server = new MonitorServer(stateTracker, WORKSPACE_DIR, YAML_PATH, runManager, experienceStore, beforeLoopManager, steeringSink, modelRegistry, roleAssetManager);
	const port = server.start(7878);

	// 7. Wire ActivityLogger → SSE
	activityLogger.setBroadcaster(server);

	logger.info([
		"",
		"┌──────────────────────────────────────────────────┐",
		`│  SatoPi MonitorServer (real swarm backend)       │`,
		`│  Swarm: ${swarmName.padEnd(40)}│`,
		`│  API:   http://127.0.0.1:${String(port).padEnd(24)}│`,
		`│  SSE:   http://127.0.0.1:${port}/events            │`,
		`│  YAML:  ${YAML_PATH.slice(0, 37).padEnd(37)}│`,
		"│  POST /api/run/start  → launch swarm             │",
		"│  POST /api/run/stop   → abort swarm              │",
		"│  GET  /api/after-loop/summary → last run result  │",
		"│  GET  /api/experience?q=...   → search lessons    │",
		"└──────────────────────────────────────────────────┘",
	].join("\n"));

	// Graceful shutdown
	const shutdown = () => {
		logger.info("Shutting down MonitorServer...");
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
	logger.error("Failed to start MonitorServer", { error: String(err) });
	process.exit(1);
});
