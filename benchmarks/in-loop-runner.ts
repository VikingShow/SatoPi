/**
 * Headless LoopController Benchmark Runner
 *
 * 职责：
 *   1. 解析 loop YAML 配置
 *   2. 初始化 workspace（拷贝 input 文件）
 *   3. 实例化 LoopController 并注入 plan
 *   4. 运行 runLoop() 收集结果
 *   5. 校验输出（与 expected 对比）
 *   6. 向 metaharness store 写入结果
 *
 * 使用方式：
 *   bun run benchmarks/in-loop-runner.ts --task-dir benchmarks/custom-tasks \
 *        --loop-yaml benchmarks/configs/arm-a-baseline.yaml --arm arm-a --model deepseek-v4-pro
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { parseSwarmYaml, validateSwarmDefinition } from "../packages/coding-agent/src/swarm/schema";
import { StateTracker } from "../packages/coding-agent/src/swarm/state";
import { LoopController, type LoopResult } from "../packages/coding-agent/src/swarm/loop-controller";
import { verifyExpectedFiles } from "../packages/typescript-edit-benchmark/src/verify";
import { loadTasksFromDir, type EditTask } from "../packages/typescript-edit-benchmark/src/tasks";
import { RunStore } from "../packages/metaharness/src/store";
import type { VerificationResult } from "../packages/typescript-edit-benchmark/src/verify";

// ============================================================================
// Types
// ============================================================================

interface BenchmarkConfig {
	taskDir: string;
	loopYamlPath: string;
	armLabel: string;
	experimentId: string;
	model: string;
	outputDir: string;
	store: RunStore;
	storeDir: string;
}

interface TaskResult {
	taskId: string;
	status: "pass" | "fail" | "error" | "timeout";
	verificationResult?: VerificationResult;
	durationMs: number;
	iterations: number;
	error?: string;
	tokIn: number;
	tokOut: number;
	tokCache: number;
	costUsd: number;
}

interface ArmSummary {
	armLabel: string;
	total: number;
	pass: number;
	fail: number;
	error: number;
	passRate: number;
	totalDurationMs: number;
	totalTokIn: number;
	totalTokOut: number;
	totalTokCache: number;
	totalCostUsd: number;
	avgIndentScore: number;
	results: TaskResult[];
}

// ============================================================================
// Core Runner
// ============================================================================

async function prepareWorkspace(task: EditTask): Promise<string> {
	const workspace = path.join(import.meta.dirname!, "..", ".tmp-bench-workspace", `run-${Date.now()}-${task.id}`);
	await fs.mkdir(workspace, { recursive: true });

	const copyDir = async (src: string, dest: string) => {
		await fs.mkdir(dest, { recursive: true });
		const entries = await fs.readdir(src, { withFileTypes: true });
		for (const entry of entries) {
			const srcPath = path.join(src, entry.name);
			const destPath = path.join(dest, entry.name);
			if (entry.isDirectory()) {
				await copyDir(srcPath, destPath);
			} else {
				await fs.copyFile(srcPath, destPath);
			}
		}
	};

	await copyDir(task.inputDir, workspace);

	// Git init for snapshots
	try {
		const { execSync } = await import("node:child_process");
		execSync("git init", { cwd: workspace, stdio: "ignore" });
		execSync("git config user.email 'bench@satopi.local'", { cwd: workspace, stdio: "ignore" });
		execSync("git config user.name 'Bench Runner'", { cwd: workspace, stdio: "ignore" });
		execSync("git add -A && git commit --allow-empty -m 'bench-init'", { cwd: workspace, stdio: "ignore" });
	} catch {
		// Non-critical
	}

	return workspace;
}

async function runSingleTask(task: EditTask, config: BenchmarkConfig): Promise<TaskResult> {
	const startTime = Date.now();
	let workspace = "";

	try {
		// 1. Parse loop YAML
		const yamlContent = await Bun.file(config.loopYamlPath).text();
		const def = parseSwarmYaml(yamlContent);
		const errors = validateSwarmDefinition(def);
		if (errors.length > 0 || !def.loopConfig) {
			return {
				taskId: task.id,
				status: "error",
				durationMs: Date.now() - startTime,
				iterations: 0,
				error: errors.length > 0 ? errors.join("; ") : "No loopConfig",
				tokIn: 0,
				tokOut: 0,
				tokCache: 0,
				costUsd: 0,
			};
		}

		// 2. Prepare workspace
		workspace = await prepareWorkspace(task);

		// 3. Init StateTracker + force running phase
		const tracker = new StateTracker(workspace, def.name);
		const agentNames = [...def.agents.keys()];
		await tracker.init(agentNames, def.loopConfig.maxIterations, def.mode);
		tracker.updatePipeline({ loopPhase: "running" });

		// 4. Create & run LoopController
		const controller = new LoopController({
			loopConfig: def.loopConfig,
			workspace,
			planContent: task.prompt,
			stateTracker: tracker,
		});

		const loopResult: LoopResult = await controller.runLoop({
			workspace,
			planContent: task.prompt,
			onProgress: (s) =>
				console.log(`  [${task.id}] iter=${s.iteration}, agents=${Object.keys(s.agents).length}`),
		});

		const durationMs = Date.now() - startTime;

		// 5. Verify
		const verResult = await verifyExpectedFiles(task.expectedDir, workspace);

		// Debug: show diff on failure
		if (!verResult.success) {
			console.log(`  [verify] FAILED: ${verResult.error ?? "unknown"}`);
			if (verResult.diff) {
				console.log(`  [verify] Diff:\n${verResult.diff.split("\n").map(l => "    | " + l).join("\n")}`);
			}
			// Show actual file contents for diagnostics
			const expectedFiles = await import("../packages/typescript-edit-benchmark/src/shared")
				.then(m => m.listFiles(task.expectedDir))
				.catch(() => [] as string[]);
			for (const file of expectedFiles) {
				try {
					const actualPath = path.join(workspace, file);
					const actualContent = await fs.readFile(actualPath, "utf-8").catch(() => null);
					if (actualContent) {
						console.log(`  [verify] Actual ${file} (${actualContent.length}B): ${actualContent.substring(0, 200)}...`);
					} else {
						console.log(`  [verify] Actual ${file}: FILE NOT FOUND`);
					}
				} catch {
					console.log(`  [verify] Actual ${file}: ERROR reading`);
				}
			}
		}

		return {
			taskId: task.id,
			status: verResult.success ? "pass" : "fail",
			verificationResult: verResult,
			durationMs,
			iterations: loopResult.iterations,
			tokIn: 0,
			tokOut: 0,
			tokCache: 0,
			costUsd: 0,
		};
	} catch (err) {
		return {
			taskId: task.id,
			status: "error",
			durationMs: Date.now() - startTime,
			iterations: 0,
			error: err instanceof Error ? err.message : String(err),
			tokIn: 0,
			tokOut: 0,
			tokCache: 0,
			costUsd: 0,
		};
	} finally {
		if (process.env.KEEP_WORKSPACE !== "1" && workspace) {
			try {
				await fs.rm(workspace, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	}
}

// ============================================================================
// Metaharness Integration
// ============================================================================

function writeMetaharnessResults(store: RunStore, summary: ArmSummary, config: BenchmarkConfig): void {
	const jobName = `${config.experimentId}-${config.armLabel}`;

	// Write trial artifacts to disk so metaharness syncRun can read them
	for (const r of summary.results) {
		const trialDir = path.join(config.storeDir, jobName, r.taskId);
		fsSync.mkdirSync(trialDir, { recursive: true });
		const result = {
			taskId: r.taskId,
			status: r.status,
			reward: r.status === "pass" ? 1 : 0,
			durationMs: r.durationMs,
			error: r.error ?? "",
			indentScore: r.verificationResult?.indentScore ?? 0,
		};
		fsSync.writeFileSync(path.join(trialDir, "trial.json"), JSON.stringify(result, null, 2));
	}

	// Job metadata
	const jobDir = path.join(config.storeDir, jobName);
	fsSync.mkdirSync(jobDir, { recursive: true });
	fsSync.writeFileSync(
		path.join(jobDir, "job.json"),
		JSON.stringify(
			{
				nTotal: summary.total,
				model: config.model,
				armLabel: config.armLabel,
				costUsd: summary.totalCostUsd,
				tokIn: summary.totalTokIn,
				tokOut: summary.totalTokOut,
			},
			null,
			2,
		),
	);

	store.registerLaunch({
		benchmark: "harbor",
		jobName,
		dataset: "custom-tasks",
		agent: "omp",
		models: [config.model],
		pid: process.pid,
		role: config.armLabel === "arm-a-baseline" ? "baseline" : "variant",
		note: `${config.experimentId}: ${config.armLabel}`,
		config: {
			loopYaml: config.loopYamlPath,
			armLabel: config.armLabel,
		},
	});

	// Manually finalize the run row (syncRun won't work without proper harbor format)
	store.syncRun(jobName);
	console.log(`\n✓ Results written to metaharness store: ${jobName}`);
}

// ============================================================================
// Summary
// ============================================================================

function printSummary(summary: ArmSummary): void {
	console.log(`\n${"=".repeat(60)}`);
	console.log(`  ${summary.armLabel.toUpperCase()} — Benchmark Summary`);
	console.log(`${"=".repeat(60)}`);
	console.log(`  Tasks:     ${summary.total}`);
	console.log(`  Passed:    ${summary.pass} (${(summary.passRate * 100).toFixed(1)}%)`);
	console.log(`  Failed:    ${summary.fail}`);
	console.log(`  Errors:    ${summary.error}`);
	console.log(`  Duration:  ${(summary.totalDurationMs / 1000).toFixed(1)}s`);
	console.log(`  Avg Indent: ${summary.avgIndentScore.toFixed(2)}`);
	console.log(`${"=".repeat(60)}\n`);

	for (const r of summary.results) {
		const icon = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "⚠";
		const indent = r.verificationResult?.indentScore?.toFixed(1) ?? "?";
		const err = r.error ? ` err="${r.error}"` : "";
		console.log(`  ${icon} ${r.taskId} (${r.durationMs}ms, ${r.iterations} iter) indent=${indent}${err}`);
	}
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
	const { values } = parseArgs({
		options: {
			"task-dir": { type: "string", short: "t" },
			"task-filter": { type: "string", short: "f" },
			"loop-yaml": { type: "string", short: "y" },
			arm: { type: "string", short: "a" },
			experiment: { type: "string", short: "e", default: "sato-ablation" },
			model: { type: "string", short: "m", default: "deepseek-v4-pro" },
			"output-dir": { type: "string", short: "o", default: "benchmarks/results" },
			"store-dir": { type: "string", default: ".metaharness-jobs" },
		},
	});

	const taskDirVal = values["task-dir"];
	const loopYamlVal = values["loop-yaml"];
	const armVal = values["arm"];

	if (!taskDirVal || !loopYamlVal || !armVal) {
		console.error("Usage: bun run in-loop-runner.ts --task-dir <dir> --loop-yaml <file> --arm <label>");
		process.exit(1);
	}

	const outputDir = path.resolve(values["output-dir"] ?? "benchmarks/results");
	const storeDir = path.resolve(values["store-dir"]!);
	await fs.mkdir(outputDir, { recursive: true });
	await fs.mkdir(storeDir, { recursive: true });

	const store = new RunStore(storeDir);

	const config: BenchmarkConfig = {
		taskDir: path.resolve(taskDirVal),
		loopYamlPath: path.resolve(loopYamlVal),
		armLabel: armVal,
		experimentId: values["experiment"]!,
		model: values["model"]!,
		outputDir,
		store,
		storeDir,
	};

	console.log(`\n=== SatoPi In-Loop Benchmark Runner ===`);
	console.log(`Arm:   ${config.armLabel} (${config.experimentId})`);
	console.log(`Model: ${config.model}`);
	console.log(`Tasks: ${config.taskDir}`);
	console.log(`YAML:  ${config.loopYamlPath}\n`);

	// Load all tasks from the fixtures directory
	// (taskDir should be the parent fixtures dir like benchmarks/custom-tasks)
	const allTasks = await loadTasksFromDir(config.taskDir);
	console.log(`Loaded ${allTasks.length} task(s)\n`);

	// Optional: filter to a single task for quick smoke testing
	const taskFilter = values["task-filter"];
	const tasks = taskFilter
		? allTasks.filter((t) => t.id === taskFilter)
		: allTasks;

	if (tasks.length === 0) {
		console.error(`No tasks found${taskFilter ? ` matching filter "${taskFilter}"` : ""}`);
		process.exit(1);
	}

	if (taskFilter) {
		console.log(`Filtered to 1 task: ${taskFilter}\n`);
	}

	const results: TaskResult[] = [];
	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i]!;
		console.log(`[${i + 1}/${tasks.length}] Running: ${task.id}`);
		const result = await runSingleTask(task, config);
		results.push(result);

		const icon = result.status === "pass" ? "✓" : result.status === "fail" ? "✗" : "⚠";
		console.log(`  ${icon} ${result.status.toUpperCase()} (${(result.durationMs / 1000).toFixed(1)}s, ${result.iterations} iter)\n`);
	}

	const pass = results.filter((r) => r.status === "pass").length;
	const fail = results.filter((r) => r.status === "fail").length;
	const errCount = results.filter((r) => r.status === "error").length;
	const totalDuration = results.reduce((s, r) => s + r.durationMs, 0);
	const indentScores = results.filter((r) => r.verificationResult?.indentScore != null);
	const avgIndent =
		indentScores.length > 0
			? indentScores.reduce((s, r) => s + (r.verificationResult!.indentScore ?? 0), 0) / indentScores.length
			: 0;

	const summary: ArmSummary = {
		armLabel: config.armLabel,
		total: results.length,
		pass,
		fail,
		error: errCount,
		passRate: results.length > 0 ? pass / results.length : 0,
		totalDurationMs: totalDuration,
		totalTokIn: results.reduce((s, r) => s + r.tokIn, 0),
		totalTokOut: results.reduce((s, r) => s + r.tokOut, 0),
		totalTokCache: results.reduce((s, r) => s + r.tokCache, 0),
		totalCostUsd: results.reduce((s, r) => s + r.costUsd, 0),
		avgIndentScore: avgIndent,
		results,
	};

	printSummary(summary);
	writeMetaharnessResults(store, summary, config);

	const reportPath = path.join(outputDir, `${config.armLabel}-${Date.now()}.json`);
	await Bun.write(reportPath, JSON.stringify(summary, null, 2));
	console.log(`Report saved: ${reportPath}`);

	store.close();
}

main().catch((err) => {
	console.error(`FATAL: ${err.message}`);
	console.error(err.stack);
	process.exit(1);
});
