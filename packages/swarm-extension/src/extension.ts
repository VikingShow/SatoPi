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
import { formatDuration } from "@oh-my-pi/pi-utils";
import { buildDependencyGraph, buildExecutionWaves, detectCycles } from "@oh-my-pi/pi-coding-agent/swarm/dag";
import { createLoopController } from "@oh-my-pi/pi-coding-agent/swarm/loop-controller";
import { PipelineController } from "@oh-my-pi/pi-coding-agent/swarm/pipeline";
import { renderSwarmProgress } from "@oh-my-pi/pi-coding-agent/swarm/render";
import { parseSwarmYaml, type SwarmDefinition, validateSwarmDefinition } from "@oh-my-pi/pi-coding-agent/swarm/schema";
import { StateTracker } from "@oh-my-pi/pi-coding-agent/swarm/state";
import { extractLessons, ExperienceStore } from "@oh-my-pi/pi-coding-agent/swarm/after-loop";
import { planExists } from "@oh-my-pi/pi-coding-agent/swarm/before-loop";

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
			if (!prefix) return [
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
				const yamlPath = findOmpYaml(ctx.cwd, ".omp/loop.yaml")
					|| findOmpYaml(ctx.cwd, ".omp/loop-test.yaml");
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
			const yamlPath = findOmpYaml(ctx.cwd, ".omp/loop.yaml")
				|| findOmpYaml(ctx.cwd, ".omp/loop-test.yaml");
			if (!yamlPath) {
				ctx.ui.notify("No swarm YAML found. Create .omp/loop.yaml or pass a path: /loopeng <file.yaml>", "error");
				return;
			}

			// Resolve workspace to check for plan.md
			const yamlDir = path.dirname(yamlPath);
			const hasPlan = await planExists(yamlDir);

			if (hasPlan) {
				// Plan exists — run directly
				await handleRun(yamlPath, ctx, pi);
				return;
			}

			// No plan.md — start Before Loop phase
			ctx.ui.notify(
				[
					"# Before Loop — Planning Phase",
					"",
					"I'll help you plan this task. Let me understand what you want to achieve.",
					"",
					"Tell me about the task, and I'll ask clarifying questions.",
					"Once we're clear, I'll write the plan and propose worker/cloner counts.",
					"",
					"When ready, type `/loopeng start` to begin execution.",
				].join("\n"),
				"info",
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
	await stateTracker.init([...def.agents.keys()], def.targetCount, def.mode);

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

	ctx.ui.notify(
		`Starting swarm '${def.name}': ${def.agents.size} agents, ${waves.length} waves, ${def.targetCount} iteration(s)`,
		"info",
	);

	// 8. Set up progress widget
	const widgetKey = `swarm-${def.name}`;
	const updateWidget = () => {
		const lines = renderSwarmProgress(stateTracker.state);
		ctx.ui.setWidget(widgetKey, lines);
	};
	updateWidget();

	// 9. Run pipeline — route by mode
	if (def.mode === "loop" && def.loopConfig) {
		// Read plan.md from workspace if it exists
		let planContent: string | undefined;
		try {
			planContent = await Bun.file(path.join(workspace, ".omp", "plan.md")).text();
		} catch { /* plan.md is optional */ }

		const loopCtrl = createLoopController(stateTracker, {
			loopConfig: def.loopConfig,
			workspace,
		});

		const loopResult = await loopCtrl.runLoop({
			workspace,
			onProgress: () => updateWidget(),
			modelRegistry: ctx.modelRegistry,
			settings: pi.pi.settings,
			planContent,
		});

		const loopStatus =
			loopResult.status === "completed"
				? "completed"
				: loopResult.status === "aborted"
					? "aborted"
					: "failed";
		const result = {
			status: loopStatus,
			iterations: loopResult.iterations,
			errors: loopResult.errors,
		};

		// After Loop — persist experience for future runs
		try {
			const store = new ExperienceStore(workspace);
			await store.init();
			const extraction = extractLessons(loopResult, def.loopConfig.workers.initial, def.loopConfig.cloners.count);
			for (const lesson of extraction.lessons) {
				store.saveLesson({
					runId: `loop-${def.name}-${Date.now()}`,
					timestamp: new Date().toISOString(),
					lesson,
					stats: extraction.stats,
				});
			}
			// Write human-readable summary
			const summary = buildSummaryMessage(def, result, stateTracker, workspace) +
				`\n\n### Lessons Learned\n\n` +
				extraction.lessons.map(l => `- [${l.type}] ${l.summary}`).join("\n");
			await store.writeSummary(`loop-${def.name}-${Date.now()}`, summary);
			pi.logger.debug("Loop experience persisted", {
				lessonCount: extraction.lessons.length,
				workspace,
			});
		} catch (err) {
			// Non-fatal: loop succeeded, just logging failed
			pi.logger.warn("Failed to persist loop experience", { error: String(err) });
		}

		// 10. Clear widget and show summary (loop)
		ctx.ui.setWidget(widgetKey, undefined);

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
		} catch { /* not found, walk up */ }
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
	lines.push(`- **Iterations**: ${result.iterations}/${def.targetCount}`);
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
