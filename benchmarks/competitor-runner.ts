/**
 * Competitor Runner — Aider CLI Benchmark Wrapper
 *
 * 通过 Aider CLI 在相同任务上运行，收集结果，统一输出格式与 SatoPi 对比。
 *
 * 前置条件：aider 已安装 (`pip install aider-chat`)
 *
 * 使用方式：
 *   bun run benchmarks/competitor-runner.ts --task-dir benchmarks/custom-tasks \
 *        --arm aider-baseline --model deepseek/deepseek-chat
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { execSync, exec } from "node:child_process";
import { loadTasksFromDir, type EditTask } from "../packages/typescript-edit-benchmark/src/tasks";
import { verifyExpectedFiles, type VerificationResult } from "../packages/typescript-edit-benchmark/src/verify";
import { RunStore } from "../packages/metaharness/src/store";

// ============================================================================
// Types
// ============================================================================

interface CompetitorConfig {
	taskDir: string;
	armLabel: string;
	experimentId: string;
	model: string;
	outputDir: string;
	storeDir: string;
}

interface CompetitorTaskResult {
	taskId: string;
	status: "pass" | "fail" | "error" | "timeout";
	verificationResult?: VerificationResult;
	durationMs: number;
	error?: string;
	tokIn: number;
	tokOut: number;
	costUsd: number;
}

// ============================================================================
// Aider Execution
// ============================================================================

async function runAiderOnTask(task: EditTask, config: CompetitorConfig): Promise<CompetitorTaskResult> {
	const startTime = Date.now();
	const workspace = path.join(import.meta.dirname!, "..", ".tmp-aider-workspace", `run-${Date.now()}-${task.id}`);
	let dirCreated = false;

	try {
		// Copy input files
		await fs.mkdir(workspace, { recursive: true });
		dirCreated = true;
		const copyDir = async (src: string, dest: string) => {
			await fs.mkdir(dest, { recursive: true });
			const entries = await fs.readdir(src, { withFileTypes: true });
			for (const entry of entries) {
				const sp = path.join(src, entry.name);
				const dp = path.join(dest, entry.name);
				if (entry.isDirectory()) {
					await copyDir(sp, dp);
				} else {
					await fs.copyFile(sp, dp);
				}
			}
		};
		await copyDir(task.inputDir, workspace);

		// Git init (aider requires a git repo)
		try {
			execSync("git init", { cwd: workspace, stdio: "ignore" });
			execSync("git config user.email 'aider@bench.local'", { cwd: workspace, stdio: "ignore" });
			execSync("git config user.name 'AiderBench'", { cwd: workspace, stdio: "ignore" });
			execSync("git add -A && git commit --allow-empty -m 'init'", { cwd: workspace, stdio: "ignore" });
		} catch {
			// Non-critical
		}

		// Write prompt to a file
		await Bun.write(path.join(workspace, ".aider-prompt.md"), task.prompt);

		// Run aider with the prompt in a message file
		const aiderCmd = [
			"aider",
			"--no-git",
			"--no-auto-commits",
			`--model ${config.model}`,
			"--yes",
			`--message-file .aider-prompt.md`,
		].join(" ");

		console.log(`  [aider] Executing: ${aiderCmd} in ${workspace}`);

		await new Promise<void>((resolve, reject) => {
			const proc = exec(aiderCmd, {
				cwd: workspace,
				timeout: 600_000, // 10 min timeout
				maxBuffer: 10 * 1024 * 1024,
			});

			let stderr = "";
			proc.stderr?.on("data", (d: string) => {
				stderr += d;
			});

			proc.on("close", (code) => {
				if (code === 0 || code === null) {
					resolve();
				} else {
					reject(new Error(`Aider exited with code ${code}: ${stderr.slice(-500)}`));
				}
			});

			proc.on("error", reject);
		});

		const durationMs = Date.now() - startTime;

		// Verify output
		const verResult = await verifyExpectedFiles(task.expectedDir, workspace);

		return {
			taskId: task.id,
			status: verResult.success ? "pass" : "fail",
			verificationResult: verResult,
			durationMs,
			tokIn: 0,
			tokOut: 0,
			costUsd: 0,
		};
	} catch (err) {
		return {
			taskId: task.id,
			status: "error",
			durationMs: Date.now() - startTime,
			error: err instanceof Error ? err.message : String(err),
			tokIn: 0,
			tokOut: 0,
			costUsd: 0,
		};
	} finally {
		if (process.env.KEEP_WORKSPACE !== "1" && dirCreated) {
			try {
				await fs.rm(workspace, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	}
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
	const { values } = parseArgs({
		options: {
			"task-dir": { type: "string", short: "t" },
			arm: { type: "string", short: "a", default: "aider-baseline" },
			experiment: { type: "string", short: "e", default: "sato-competitor" },
			model: { type: "string", short: "m", default: "deepseek/deepseek-chat" },
			"output-dir": { type: "string", short: "o", default: "benchmarks/results" },
			"store-dir": { type: "string", default: ".metaharness-jobs" },
		},
	});

	const taskDirVal = values["task-dir"];
	if (!taskDirVal) {
		console.error("Usage: bun run competitor-runner.ts --task-dir <dir> --arm <label> --model <aider-model>");
		process.exit(1);
	}

	const outputDir = path.resolve(values["output-dir"]!);
	const storeDir = path.resolve(values["store-dir"]!);
	await fs.mkdir(outputDir, { recursive: true });
	await fs.mkdir(storeDir, { recursive: true });

	const config: CompetitorConfig = {
		taskDir: path.resolve(taskDirVal),
		armLabel: values["arm"]!,
		experimentId: values["experiment"]!,
		model: values["model"]!,
		outputDir,
		storeDir,
	};

	const store = new RunStore(storeDir);
	store.setExperimentGoal(
		config.experimentId,
		`Competitor comparison: SatoPi best config vs Aider (${config.model}) on custom coding tasks`,
	);

	console.log(`\n=== Competitor Runner: Aider ===`);
	console.log(`Arm:   ${config.armLabel}`);
	console.log(`Model: ${config.model}`);
	console.log(`Tasks: ${config.taskDir}\n`);

	const tasks = await loadTasksFromDir(config.taskDir);
	console.log(`Loaded ${tasks.length} task(s)\n`);

	const results: CompetitorTaskResult[] = [];
	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i]!;
		console.log(`[${i + 1}/${tasks.length}] Running: ${task.id}`);
		const result = await runAiderOnTask(task, config);
		results.push(result);

		const icon = result.status === "pass" ? "✓" : result.status === "fail" ? "✗" : "⚠";
		console.log(`  ${icon} ${result.status.toUpperCase()} (${(result.durationMs / 1000).toFixed(1)}s)\n`);
	}

	const pass = results.filter((r) => r.status === "pass").length;
	const fail = results.filter((r) => r.status === "fail").length;
	const errCount = results.filter((r) => r.status === "error").length;

	console.log(`\n${"=".repeat(40)}`);
	console.log(`  ${config.armLabel}: ${pass}/${tasks.length} passed (${((pass / tasks.length) * 100).toFixed(1)}%)`);
	console.log(`  Failed: ${fail}, Errors: ${errCount}`);
	console.log(`${"=".repeat(40)}\n`);

	const jobName = `${config.experimentId}-${config.armLabel}`;
	store.registerLaunch({
		benchmark: "harbor",
		jobName,
		dataset: "custom-tasks",
		agent: "aider",
		models: [config.model],
		pid: process.pid,
		role: "variant",
		note: `Aider competitor: model=${config.model}`,
		config: { tool: "aider", model: config.model },
	});

	const reportPath = path.join(outputDir, `${config.armLabel}-${Date.now()}.json`);
	await Bun.write(reportPath, JSON.stringify(results, null, 2));
	console.log(`Report saved: ${reportPath}`);

	store.close();
}

main().catch((err) => {
	console.error(`FATAL: ${err.message}`);
	process.exit(1);
});
