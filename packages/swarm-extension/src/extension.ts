/**
 * Swarm Extension — Multi-agent pipeline orchestration from YAML definitions.
 *
 * Registers:
 * - /swarm run <file.yaml>    — Execute a swarm pipeline
 * - /swarm status              — Show current pipeline status
 * - /loopeng [file.yaml]       — Start Loop Engineering (auto-resolves YAML)
 *
 * Usage: Add this extension's directory to your extensions config,
 * then use /swarm in any oh-my-pi session.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { ExperienceStore, extractLessons } from "@oh-my-pi/pi-coding-agent/swarm/curtain/index";
import {
	generatePlanningPrompt,
	planExists,
	runPlanDebate,
	stampAndArchivePlanMd,
} from "@oh-my-pi/pi-coding-agent/swarm/script/script-planner";
import { buildDependencyGraph, buildExecutionWaves, detectCycles } from "@oh-my-pi/pi-coding-agent/swarm/core/dag";
import { createLoopController, type LoopResult } from "@oh-my-pi/pi-coding-agent/swarm/stage/stage-controller";
import { PipelineController } from "@oh-my-pi/pi-coding-agent/swarm/core/pipeline";
import { renderSwarmProgress } from "@oh-my-pi/pi-coding-agent/swarm/render/render";
import {
	parseSwarmYaml,
	resolveLoopConfig,
	type SwarmDefinition,
	validateSwarmDefinition,
} from "@oh-my-pi/pi-coding-agent/swarm/core/schema";
import { StateTracker } from "@oh-my-pi/pi-coding-agent/swarm/core/state";
import { TaskComplexityAnalyzer } from "@oh-my-pi/pi-coding-agent/swarm/script/task-analyzer";
import { ActivityLogger } from "@oh-my-pi/pi-coding-agent/swarm/hooks/activity-logger";
import { MonitorServer } from "@oh-my-pi/pi-coding-agent/swarm/monitor";
import { formatDuration } from "@oh-my-pi/pi-utils";

export default function swarmExtension(pi: ExtensionAPI): void {
	pi.setLabel("Swarm Orchestrator");

	pi.registerCommand("swarm", {
		description: "Run a multi-agent swarm pipeline from YAML",
		getArgumentCompletions: prefix => {
			const subcommands = ["run", "status", "help"];
			if (!prefix) return subcommands.map(s => ({ label: s, value: s }));
			return subcommands.filter(s => s.startsWith(prefix)).map(s => ({ label: s, value: s }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0] ?? "help";

			switch (subcommand) {
				case "run": {
					const yamlPath = parts[1];
					if (!yamlPath) {
						ctx.ui.notify("Usage: /swarm run <path/to/pipeline.yaml>", "error");
						return;
					}
					await handleRun(yamlPath, ctx, pi);
					return;
				}
				case "status": {
					await handleStatus(parts[1], ctx);
					return;
				}
				default:
					ctx.ui.notify(
						[
							"Swarm — multi-agent pipeline orchestrator",
							"",
							"  /swarm run <file.yaml>     Run a pipeline",
							"  /swarm status [name]       Show pipeline status",
							"  /swarm help                Show this help",
						].join("\n"),
						"info",
					);
					return;
			}
		},
	});
	// /loopeng — Loop Engineering mode with Before Loop planning phase.
	// /loopeng             → start Before Loop (or run if plan.md exists)
	// /loopeng start       → force-start the loop
	// /loopeng <file.yaml> → run with explicit YAML (skip Before Loop)
	pi.registerCommand("loopeng", {
		description: "Start Loop Engineering — multi-agent swarm with roundtable & review council",
		getArgumentCompletions: prefix => {
			const actions = ["start"];
			if (!prefix)
				return [
					...actions.map(s => ({ label: s, value: s })),
					{ label: ".omp/loop-test.yaml", value: ".omp/loop-test.yaml" },
					{ label: ".omp/loop.yaml", value: ".omp/loop.yaml" },
				];
			const matching = actions.filter(s => s.startsWith(prefix));
			if (matching.length > 0) return matching.map(s => ({ label: s, value: s }));
			return [];
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();

			// Subcommand: /loopeng start — force-start, skip Before Loop
			if (trimmed === "start") {
				const yamlPath = findOmpYaml(ctx.cwd, ".omp/loop.yaml") || findOmpYaml(ctx.cwd, ".omp/loop-test.yaml");
				if (!yamlPath) {
					ctx.ui.notify("No swarm YAML found. Create .omp/loop.yaml or .omp/loop-test.yaml first.", "error");
					return;
				}
				await handleRun(yamlPath, ctx, pi);
				return;
			}

			// Explicit YAML path — run directly, skip Before Loop
			if (trimmed && trimmed !== "start") {
				await handleRun(trimmed, ctx, pi);
				return;
			}

			// /loopeng (no args) — start Before Loop if plan.md missing
			const yamlPath = findOmpYaml(ctx.cwd, ".omp/loop.yaml") || findOmpYaml(ctx.cwd, ".omp/loop-test.yaml");
			if (!yamlPath) {
				ctx.ui.notify("No swarm YAML found. Create .omp/loop.yaml or pass a path: /loopeng <file.yaml>", "error");
				return;
			}

			// Parse YAML to resolve workspace, then check for plan.md in the
			// correct location ({workspace}/.omp/plan.md).  Using yamlDir here
			// would check {yamlDir}/.omp/plan.md — a nested .omp/.omp/ path.
			const yamlDir = path.dirname(yamlPath);
			const resolvedPath = path.resolve(yamlPath);
			let def: SwarmDefinition;
			try {
				const yamlContent = await Bun.file(resolvedPath).text();
				def = parseSwarmYaml(yamlContent);
			} catch {
				def = { name: "loop", workspace: yamlDir, mode: "loop", agents: new Map(), agentOrder: [], targetCount: 1 };
			}

			const workspace = path.isAbsolute(def.workspace) ? def.workspace : path.resolve(yamlDir, def.workspace);
			const hasPlan = await planExists(stateTracker.swarmDir);

			if (hasPlan) {
				// Plan exists — run directly
				await handleRun(yamlPath, ctx, pi);
				return;
			}

			// No plan.md — start Before Loop phase with experience readback

			// Load past experience
			let store: ExperienceStore | undefined;
			try {
				store = new ExperienceStore(workspace);
				await store.init();
			} catch {
				/* experience store is optional */
			}

			const loopConfig = def.loopConfig ?? resolveLoopConfig({});

			const prompt = await generatePlanningPrompt({ workspace, loopConfig, taskDescription: undefined }, store);

			pi.sendMessage(
				{
					customType: "script-planning",
					content: [{ type: "text", text: prompt }],
					display: true,
				},
				{ triggerTurn: true },
			);
		},
	});
}

// ============================================================================
// /swarm run
// ============================================================================

async function handleRun(yamlPath: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	// 1. Resolve and read YAML
	const resolvedPath = path.isAbsolute(yamlPath) ? yamlPath : path.resolve(ctx.cwd, yamlPath);

	let content: string;
	try {
		content = await Bun.file(resolvedPath).text();
	} catch {
		ctx.ui.notify(`Cannot read file: ${resolvedPath}`, "error");
		return;
	}

	// 2. Parse YAML
	let def: SwarmDefinition;
	try {
		def = parseSwarmYaml(content);
	} catch (err) {
		ctx.ui.notify(`YAML error: ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}

	// 3. Validate
	const validationErrors = validateSwarmDefinition(def);
	if (validationErrors.length > 0) {
		ctx.ui.notify(`Validation errors:\n${validationErrors.map(e => `  - ${e}`).join("\n")}`, "error");
		return;
	}

	// 4. Build DAG
	const deps = buildDependencyGraph(def);
	const cycleNodes = detectCycles(deps);
	if (cycleNodes) {
		ctx.ui.notify(`Cycle detected in agent dependencies: [${cycleNodes.join(", ")}]`, "error");
		return;
	}
	const waves = buildExecutionWaves(deps);

	// 5. Resolve workspace (relative to YAML file location)
	const workspace = path.isAbsolute(def.workspace)
		? def.workspace
		: path.resolve(path.dirname(resolvedPath), def.workspace);

	// Ensure workspace exists
	await fs.mkdir(workspace, { recursive: true });

	// 6. Initialize state tracker
	const stateTracker = new StateTracker(workspace, def.name);
	const initTargetCount = def.mode === "loop" && def.loopConfig
		? def.loopConfig.maxIterations
		: def.targetCount;
	await stateTracker.init([...def.agents.keys()], initTargetCount, def.mode);

	// 7. Log start
	const agentList = [...def.agents.keys()].join(", ");
	const waveDesc = waves.map((w, i) => `wave ${i + 1}: [${w.join(", ")}]`).join("; ");
	pi.logger.debug("Swarm starting", {
		name: def.name,
		mode: def.mode,
		agents: agentList,
		waves: waveDesc,
		workspace,
	});

	// Loop mode shows agents/reviewers/iterations; other modes show agents/waves/targetCount
	if (def.mode === "loop" && def.loopConfig) {
		ctx.ui.notify(
			`Starting swarm '${def.name}': ${def.loopConfig.agents.initial} agents, up to ${def.loopConfig.maxIterations} iterations`,
			"info",
		);
	} else {
		ctx.ui.notify(
			`Starting swarm '${def.name}': ${def.agents.size} agents, ${waves.length} waves, ${def.targetCount} iteration(s)`,
			"info",
		);
	}

	// 8. Set up progress widget
	const widgetKey = `swarm-${def.name}`;
	const updateWidget = () => {
		const lines = renderSwarmProgress(stateTracker.state);
		ctx.ui.setWidget(widgetKey, lines);
	};
	updateWidget();

	// 9. Run pipeline — route by mode
	if (def.mode === "loop" && def.loopConfig) {
			// Set up ActivityLogger + MonitorServer for GUI integration
		const activityLogger = new ActivityLogger(stateTracker.swarmDir, def.name);
		let monitorServer: MonitorServer | null = null;
		try {
				// Create minimal SessionRegistry for TUI mode
			const { SessionRegistry: SessReg } = await import(
				"@oh-my-pi/pi-coding-agent/swarm/session-registry"
			);
			const registry = new SessReg(
				{
					workspace,
					yamlPath: resolvedPath,
					modelRegistry: ctx.modelRegistry,
					settings: pi.pi.settings,
					experienceStore: null!,
					roleAssetManager: null!,
				},
				async (_shared, name, _swarmDir) => ({
					name,
					swarmDir: stateTracker.swarmDir,
					stateTracker,
					activityLogger,
					runManager: null!,
					scriptManager: null!,
					sink: null!,
				}),
			);
			await registry.createSession(def.name);
			monitorServer = new MonitorServer(registry);
			const port = monitorServer.start(7878);
			activityLogger.setBroadcaster(monitorServer);
			pi.logger.info("MonitorServer started", { port, url: `http://127.0.0.1:${port}` });
			// Auto-open browser
			import("node:child_process").then(({ exec }) => {
				const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
				exec(`${cmd} http://127.0.0.1:${port}`);
			}).catch(() => {});
		} catch (err) {
			pi.logger.debug("MonitorServer failed to start", { error: String(err) });
		}

		// Read plan.md from session directory if it exists (stamp with timestamp on first read)
		let planContent: string | undefined;
		try {
			planContent = await stampAndArchivePlanMd(stateTracker.swarmDir, workspace);
		} catch {
			/* plan.md is optional */
		}

		// TaskComplexityAnalyzer — when agents.auto is enabled, evaluate plan.md
		// to dynamically determine agent counts instead of YAML defaults.
		if (def.loopConfig.agents.auto && planContent) {
			try {
				const analyzer = new TaskComplexityAnalyzer();
				const recommendation = await analyzer.analyze(planContent, def.loopConfig);
				def.loopConfig = {
					...def.loopConfig,
agents: { ...def.loopConfig.agents, initial: recommendation.agents,  },
				};
				pi.logger.debug("TaskComplexityAnalyzer: dynamic agent/reviewer counts", {
					agents: recommendation.agents,
				});
			} catch (err) {
				pi.logger.warn("TaskComplexityAnalyzer failed, using YAML defaults", { error: String(err) });
			}
		}
		// Run cloner plan debate on the draft plan before execution
		if (planContent && def.loopConfig.planDebate.enabled) {
			// Update widget so the user knows the system is debating, not frozen
			await stateTracker.updatePipeline({ phaseLabel: "Plan debate in progress" });
			updateWidget();
			try {
				const debateResult = await runPlanDebate(
					planContent,
					stateTracker.swarmDir,
					workspace,
					def.loopConfig,
					ctx.modelRegistry,
					pi.pi.settings,
				);
				planContent = debateResult.planContent;
				pi.logger.info("Plan debate completed", {
					refined: debateResult.refined,
					converged: debateResult.converged,
				});
			} catch (err) {
				pi.logger.warn("Plan debate failed, using draft plan", { error: String(err) });
			}
		}
		// 9. Run loop with human escalation loop
		let loopResult: LoopResult = { status: "failed", iterations: 0, reviewVerdicts: [], errors: [] };
		let retries = 0;
		const maxEscalationRetries = 3;

		while (true) {
			const loopCtrl = createLoopController(stateTracker, {
				loopConfig: def.loopConfig,
				workspace,
				activityLogger,
			});

			// -- Run the loop (catch unrecoverable crashes) --
			try {
				loopResult = await loopCtrl.runLoop({
					workspace,
					onProgress: () => updateWidget(),
					modelRegistry: ctx.modelRegistry,
					settings: pi.pi.settings,
					planContent,
				});
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				pi.logger.error("Loop crashed", {
					error: errorMsg,
					workspace,
					retries,
				});

				retries++;

				// No UI → auto-fail
				if (!ctx.hasUI || !ctx.ui.askDialog) {
					loopResult = {
						status: "failed",
						iterations: loopResult?.iterations ?? 0,
						reviewVerdicts: loopResult?.reviewVerdicts ?? [],
						errors: [...(loopResult?.errors ?? []), `Loop crashed: ${errorMsg}`],
					};
					break;
				}

				const crashAnswer = await ctx.ui.askDialog([
					{
						id: "action",
						question: [
							`## Loop Crashed — ${def.name}`,
							``,
							`**Error**: ${errorMsg}`,
							``,
							`Retry ${retries}/${maxEscalationRetries}`,
						].join("\n"),
						options: [
							{ label: "Retry", description: "Restart the loop from scratch" },
							{ label: "Abandon", description: "Abandon as failed" },
						],
						recommended: 0,
					},
				]);

				if (!crashAnswer || crashAnswer.kind === "chat") {
					loopResult = {
						status: "failed",
						iterations: loopResult?.iterations ?? 0,
						reviewVerdicts: loopResult?.reviewVerdicts ?? [],
						errors: [...(loopResult?.errors ?? []), `Loop crashed: ${errorMsg}`],
					};
					break;
				}

				const crashChosen = crashAnswer.kind === "submit" ? crashAnswer.results[0]?.selectedOptions[0] : undefined;
				if (crashChosen === "Retry" && retries < maxEscalationRetries) {
					pi.logger.debug("Loop crash retry", {
						retry: retries,
						maxRetries: maxEscalationRetries,
						workspace,
					});
					// Reset agent states for a clean retry
					await stateTracker.resetAgentStatuses();
					continue;
				}

				// Abandon or retry limit exhausted
				loopResult = {
					status: "failed",
					iterations: loopResult?.iterations ?? 0,
					reviewVerdicts: loopResult?.reviewVerdicts ?? [],
					errors: [...(loopResult?.errors ?? []), `Loop crashed: ${errorMsg}`],
				};
				break;
			}

			// Check if escalation is needed
			const needsEscalation =
				(loopResult.status === "escalated" || loopResult.status === "converged_failed") &&
				loopResult.escalationContext;
			if (!needsEscalation) break;

			// No UI → treat as terminal failure
			if (!ctx.hasUI || !ctx.ui.askDialog) break;

			const ec = loopResult.escalationContext!;
			const findingsLines =
				ec.lastFindings.length > 0 ? ec.lastFindings.map(f => `- ${f}`).join("\n") : "(no findings)";
			const reason =
				loopResult.status === "converged_failed"
					? "Findings converged with no progress"
					: `All ${def.loopConfig.maxIterations} iterations used but unresolved`;

			const answer = await ctx.ui.askDialog([
				{
					id: "action",
					question: [
						`## Loop Escalation — ${def.name}`,
						`**Reason**: ${reason}`,
						`**Approval ratio**: ${(ec.approvalRatio * 100).toFixed(0)}%`,
						``,
						`**Findings**:`,
						findingsLines,
					].join("\n"),
					options: [
						{ label: "Accept", description: "Mark as completed with current results" },
						{
							label: "Retry",
							description: `Run another loop iteration (retry ${retries + 1}/${maxEscalationRetries})`,
						},
						{ label: "Reject", description: "Abandon as failed" },
					],
					recommended: 0,
				},
			]);

			if (!answer || answer.kind === "chat") break;

			const chosen = answer.kind === "submit" ? answer.results[0]?.selectedOptions[0] : undefined;
			switch (chosen) {
				case "Accept":
					loopResult = { ...loopResult, status: "completed" };
					break;
				case "Reject":
					loopResult = { ...loopResult, status: "failed" };
					break;
				case "Retry":
					retries++;
					if (retries >= maxEscalationRetries) {
						loopResult = {
							...loopResult,
							status: "failed",
							errors: [...loopResult.errors, `Escalation retry limit (${maxEscalationRetries}) reached`],
						};
						break;
					}
					// Log retry
					pi.logger.debug("Loop escalation retry", {
						retry: retries,
						maxRetries: maxEscalationRetries,
						workspace,
					});
					// Reset agent states for a clean retry
					await stateTracker.resetAgentStatuses();
					continue;
				default:
					break;
			}
			break;
		}

	const loopStatus =
		loopResult.status === "completed" ? "completed" : loopResult.status === "aborted" ? "aborted" : "failed";
	// Clean up after loop exits (normal, crash, or escalation)

	// Finalize pipeline state — set status + completedAt so the widget and
	// summary show the correct final state and elapsed time (mirrors what
	// PipelineController does at the end of its run() method).
	await stateTracker.updatePipeline({
		status: loopStatus as "completed" | "aborted" | "failed",
		completedAt: Date.now(),
	});
	updateWidget();
	const result = {
			status: loopStatus,
			iterations: loopResult.iterations,
			errors: loopResult.errors,
		};

		// After Loop — persist experience for future runs
		try {
			const store = new ExperienceStore(workspace);
			await store.init();
			const extraction = extractLessons(loopResult, def.loopConfig.agents.initial, 0);
			const runIdBase = `loop-${def.name}-${Date.now()}`;
			const timestamp = new Date().toISOString();
			const savedRunIds: string[] = [];
			for (const [i, lesson] of extraction.lessons.entries()) {
				const runId = `${runIdBase}-${i}`;
				savedRunIds.push(runId);
				store.saveLesson({
					runId,
					timestamp,
					lesson,
					stats: extraction.stats,
					weight: 1.0,
					lastReferencedAt: undefined,
				});
			}

			// Decay unreferenced lessons (experience quality decay)
			store.decayUnreferenced(savedRunIds);

			// Check if wisdom principles should be generated
			if (store.shouldGeneratePrinciples()) {
				pi.logger.debug("Principle generation interval reached", { workspace });
				// Principle generation requires LLM call — fire-and-forget,
				// not blocking the main loop flow.
				store
					.buildPrinciplesPrompt()
					.then(() => pi.logger.debug("Principles prompt ready", { workspace }))
					.catch(() => {});
			}

			const summary =
				buildSummaryMessage(def, result, stateTracker, workspace) +
				`\n\n### Lessons Learned\n\n` +
				extraction.lessons.map(l => `- [${l.type}] ${l.summary}`).join("\n");
			await store.writeSummary(runIdBase, summary);
			pi.logger.debug("Loop experience persisted", {
				lessonCount: extraction.lessons.length,
				workspace,
			});
		} catch (err) {
			pi.logger.warn("Failed to persist loop experience", { error: String(err) });
		}

		// 10. Clear widget and show summary (loop)
		ctx.ui.setWidget(widgetKey, undefined);

		// Stop MonitorServer after loop exits
		monitorServer?.stop();
		pi.logger.info("MonitorServer stopped");

		const elapsed = stateTracker.state.completedAt
			? formatDuration(stateTracker.state.completedAt - stateTracker.state.startedAt)
			: "unknown";

		const summaryParts = [
			`Swarm '${def.name}' ${result.status}`,
			`${result.iterations}/${def.loopConfig.maxIterations} iterations`,
			`elapsed: ${elapsed}`,
		];

		if (result.errors.length > 0) {
			summaryParts.push(`${result.errors.length} error(s)`);
		}

		const summaryType = result.status === "completed" ? "info" : "error";
		ctx.ui.notify(summaryParts.join(" | "), summaryType);

		if (result.errors.length > 0) {
			pi.logger.warn("Loop completed with errors", { errors: result.errors });
		}

		const summaryMessage = buildSummaryMessage(def, result, stateTracker, workspace);
		pi.sendMessage(
			{
				customType: "swarm-result",
				content: [{ type: "text", text: summaryMessage }],
				display: true,
				details: {
					swarmName: def.name,
					status: result.status,
					iterations: result.iterations,
					errorCount: result.errors.length,
				},
			},
			{ triggerTurn: false },
		);
		return;
	}

	// Pipeline / parallel / sequential modes
	const controller = new PipelineController(def, waves, stateTracker);

	const result = await controller.run({
		workspace,
		onProgress: () => updateWidget(),
		modelRegistry: ctx.modelRegistry,
		settings: pi.pi.settings,
	});

	// 10. Clear widget and show summary
	ctx.ui.setWidget(widgetKey, undefined);

	const elapsed = stateTracker.state.completedAt
		? formatDuration(stateTracker.state.completedAt - stateTracker.state.startedAt)
		: "unknown";

	const summaryParts = [
		`Swarm '${def.name}' ${result.status}`,
		`${result.iterations}/${def.targetCount} iterations`,
		`elapsed: ${elapsed}`,
	];

	if (result.errors.length > 0) {
		summaryParts.push(`${result.errors.length} error(s)`);
	}

	const summaryType = result.status === "completed" ? "info" : "error";
	ctx.ui.notify(summaryParts.join(" | "), summaryType);

	// Log errors
	if (result.errors.length > 0) {
		pi.logger.warn("Swarm completed with errors", { errors: result.errors });
	}

	// 11. Send summary to the conversation so the LLM knows what happened
	const summaryMessage = buildSummaryMessage(def, result, stateTracker, workspace);
	pi.sendMessage(
		{
			customType: "swarm-result",
			content: [{ type: "text", text: summaryMessage }],
			display: true,
			details: {
				swarmName: def.name,
				status: result.status,
				iterations: result.iterations,
				errorCount: result.errors.length,
			},
		},
		{ triggerTurn: false },
	);
}

// ============================================================================
// /swarm status
// ============================================================================

async function handleStatus(name: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	if (!name) {
		ctx.ui.notify("Usage: /swarm status <name>  (reads .swarm_<name>/state/pipeline.json from cwd)", "info");
		return;
	}

	const stateTracker = new StateTracker(ctx.cwd, name);
	const state = await stateTracker.load();
	if (!state) {
		ctx.ui.notify(`No state found for swarm '${name}' in ${ctx.cwd}`, "error");
		return;
	}

	const lines = renderSwarmProgress(state);
	ctx.ui.notify(lines.join("\n"), "info");
}

// ============================================================================
// Helpers
// ============================================================================
function findOmpYaml(cwd: string, fileName: string): string | null {
	let dir = cwd;
	const root = path.parse(dir).root;
	while (dir !== root) {
		const candidate = path.join(dir, fileName);
		try {
			if (Bun.file(candidate).size > 0) return candidate;
		} catch {
			/* not found, walk up */
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function buildSummaryMessage(
	def: SwarmDefinition,
	result: { status: string; iterations: number; errors: string[] },
	stateTracker: StateTracker,
	workspace: string,
): string {
	const lines: string[] = [];
	lines.push(`## Swarm Pipeline: ${def.name}`);
	lines.push("");
	lines.push(`- **Status**: ${result.status}`);
	lines.push(`- **Mode**: ${def.mode}`);
	const displayTargetCount = def.mode === "loop" && def.loopConfig
		? def.loopConfig.maxIterations
		: def.targetCount;
	lines.push(`- **Iterations**: ${result.iterations}/${displayTargetCount}`);
	lines.push(`- **Workspace**: ${workspace}`);
	lines.push(`- **State dir**: ${stateTracker.swarmDir}`);
	lines.push("");

	lines.push("### Agent Results");
	lines.push("");
	for (const [name, agent] of Object.entries(stateTracker.state.agents)) {
		const duration =
			agent.startedAt && agent.completedAt ? formatDuration(agent.completedAt - agent.startedAt) : "n/a";
		lines.push(`- **${name}**: ${agent.status} (${duration})${agent.error ? ` — ${agent.error}` : ""}`);
	}

	if (result.errors.length > 0) {
		lines.push("");
		lines.push("### Errors");
		lines.push("");
		for (const error of result.errors) {
			lines.push(`- ${error}`);
		}
	}

	return lines.join("\n");
}
