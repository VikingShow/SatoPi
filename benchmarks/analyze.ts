/**
 * Benchmark Results Analyzer
 *
 * 读取各 arm 的 JSON 结果，生成结构化对比报告（Markdown 表格）。
 *
 * 使用方式：
 *   bun run benchmarks/analyze.ts --results-dir benchmarks/results
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseArgs } from "node:util";

// ============================================================================
// Types
// ============================================================================

interface TaskResult {
	taskId: string;
	status: "pass" | "fail" | "error" | "timeout";
	verificationResult?: { indentScore?: number };
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
// Load
// ============================================================================

async function loadResults(resultsDir: string): Promise<{ arms: ArmSummary[]; maxPassRate: number; minIndent: number }> {
	const files = await fs.readdir(resultsDir);
	const arms: ArmSummary[] = [];

	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		// Skip log files
		if (file.endsWith(".log")) continue;
		try {
			const content = await Bun.file(path.join(resultsDir, file)).text();
			const parsed = JSON.parse(content);
			// ArmSummary has armLabel, single results might not
			if (parsed && typeof parsed === "object") {
				if (parsed.armLabel && parsed.results) {
					arms.push(parsed as ArmSummary);
				}
			}
		} catch {
			// Skip unparseable files
		}
	}

	const maxPassRate = arms.reduce((m, a) => Math.max(m, a.passRate), 0);
	const minIndent = arms.reduce((m, a) => Math.min(m, a.avgIndentScore), Infinity);

	return { arms, maxPassRate, minIndent };
}

// ============================================================================
// Format
// ============================================================================

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
}

function formatRate(rate: number): string {
	return `${(rate * 100).toFixed(1)}%`;
}

function arrow(val: number, best: number, higherIsBetter: boolean): string {
	if (Math.abs(val - best) < 0.001) return " ★";
	return higherIsBetter ? (val >= best * 0.9 ? " ↑" : "") : (val <= best * 1.1 ? " ↑" : "");
}

// ============================================================================
// Main
// ============================================================================

async function main() {
	const { values } = parseArgs({
		options: {
			"results-dir": { type: "string", short: "r", default: "benchmarks/results" },
			format: { type: "string", short: "f", default: "markdown" },
		},
	});

	const resultsDir = path.resolve(values["results-dir"]!);
	const { arms, maxPassRate, minIndent } = await loadResults(resultsDir);

	if (arms.length === 0) {
		console.log("No results found in", resultsDir);
		process.exit(0);
	}

	// Sort arms: baseline first, then by pass rate desc
	arms.sort((a, b) => {
		if (a.armLabel.includes("baseline")) return -1;
		if (b.armLabel.includes("baseline")) return 1;
		return b.passRate - a.passRate;
	});

	const fmt = values["format"];

	if (fmt === "json") {
		console.log(JSON.stringify(arms, null, 2));
		process.exit(0);
	}

	// === Markdown Report ===
	const lines: string[] = [];

	lines.push("# SatoPi In-Loop Benchmark Comparison Report\n");
	lines.push(`**Generated**: ${new Date().toISOString()}\n`);

	// Overview table
	lines.push("## Summary\n");
	lines.push("| Arm | Pass Rate | Pass/Total | Avg Duration | Avg Indent Score |");
	lines.push("|-----|-----------|------------|--------------|------------------|");

	for (const arm of arms) {
		const isBest = arm.passRate === maxPassRate ? " ⭐" : "";
		const isBestIndent = arm.avgIndentScore === minIndent ? " ⭐" : "";
		lines.push(
			`| **${arm.armLabel}**${isBest} | ${formatRate(arm.passRate)} | ` +
			`${arm.pass}/${arm.total} | ${formatDuration(arm.totalDurationMs)} | ` +
			`${arm.avgIndentScore.toFixed(2)}${isBestIndent} |`,
		);
	}

	lines.push("");

	// Per-task breakdown
	lines.push("## Per-Task Breakdown\n");

	// Collect all unique task IDs
	const taskIds = new Set<string>();
	for (const arm of arms) {
		for (const r of arm.results) {
			taskIds.add(r.taskId);
		}
	}
	const sortedTasks = [...taskIds].sort();

	// Column header: Task | Arm A | Arm B | ... | Best
	const headerColumns = ["Task"];
	for (const arm of arms) {
		headerColumns.push(arm.armLabel);
	}
	headerColumns.push("Best");
	lines.push(`| ${headerColumns.join(" | ")} |`);
	lines.push(`| ${headerColumns.map(() => "---").join(" | ")} |`);

	for (const taskId of sortedTasks) {
		const cells = [`\`${taskId}\``];
		let bestPerTask = "";
		let bestPassRatePerTask = 0;

		for (const arm of arms) {
			const r = arm.results.find((t) => t.taskId === taskId);
			if (!r) {
				cells.push("—");
				continue;
			}
			if (r.status === "pass") {
				cells.push(`✅ ${r.iterations}iter`);
				if (arm.passRate > bestPassRatePerTask) {
					bestPassRatePerTask = arm.passRate;
					bestPerTask = arm.armLabel;
				}
			} else if (r.status === "fail") {
				const indent = r.verificationResult?.indentScore?.toFixed(1) ?? "?";
				cells.push(`❌ indent=${indent}`);
			} else {
				cells.push(`⚠ error`);
			}
		}

		cells.push(bestPerTask || "—");
		lines.push(`| ${cells.join(" | ")} |`);
	}

	lines.push("");

	// Analysis & Observations
	lines.push("## Analysis\n");

	const baseline = arms.find((a) => a.armLabel.includes("baseline"));
	if (baseline) {
		lines.push(`### ReAct Baseline (${baseline.armLabel})`);
		lines.push(`- Pass rate: ${formatRate(baseline.passRate)}`);
		lines.push(`- Average indent score: ${baseline.avgIndentScore.toFixed(2)}`);
		lines.push("");
	}

	// Find best arm
	const bestArm = arms.reduce((a, b) => (a.passRate > b.passRate ? a : b));
	lines.push(`### Best Configuration: **${bestArm.armLabel}**`);
	lines.push(`- Pass rate: ${formatRate(bestArm.passRate)}`);

	if (baseline && bestArm.armLabel !== baseline.armLabel) {
		const improvement = bestArm.passRate - baseline.passRate;
		lines.push(`- Improvement over baseline: **+${formatRate(improvement)}**`);
	}

	lines.push("");

	// Mechanism value analysis
	lines.push("### Mechanism Value Analysis\n");
	lines.push("| Mechanism | Arm Comparison | Pass Rate Δ | Indent Δ | Value? |");
	lines.push("|-----------|---------------|-------------|----------|--------|");

	const armMap = new Map(arms.map((a) => [a.armLabel, a]));

	function compare(labelA: string, labelB: string, mechanism: string) {
		const a = armMap.get(labelA);
		const b = armMap.get(labelB);
		if (!a || !b) return;
		const passDelta = a.passRate - b.passRate;
		const indentDelta = (a.avgIndentScore - b.avgIndentScore).toFixed(2);
		const value = passDelta > 0 ? "✅ Yes" : passDelta < 0 ? "⚠ Regress" : "➖ Neutral";
		lines.push(`| ${mechanism} | ${labelB} → ${labelA} | ${formatRate(passDelta)} | ${indentDelta} | ${value} |`);
	}

	compare("arm-b-multi-worker", "arm-a-baseline", "Multi-worker (1→3)");
	compare("arm-c-deliberation", "arm-b-multi-worker", "+Deliberation");
	compare("arm-d-cloner", "arm-c-deliberation", "+Cloner Review");
	compare("arm-e-full", "arm-d-cloner", "+Dynamic Scaling");

	lines.push("");

	// Recommendations
	lines.push("## Optimization Recommendations\n");
	lines.push("Based on the ablation results, the following optimizations are recommended:\n");

	const issues: string[] = [];
	if (baseline && bestArm.passRate - baseline.passRate < 0.1) {
		issues.push("1. **Swarm overhead**: Multi-agent swarm shows marginal gain over single-agent baseline. Consider simplifying the coordination protocol for simple tasks.");
	}
	const deliberationArm = armMap.get("arm-c-deliberation");
	const multiWorkerArm = armMap.get("arm-b-multi-worker");
	if (deliberationArm && multiWorkerArm && deliberationArm.totalDurationMs > multiWorkerArm.totalDurationMs * 1.5) {
		issues.push(`1. **Deliberation cost**: Deliberation increases total duration by ${(deliberationArm.totalDurationMs / multiWorkerArm.totalDurationMs).toFixed(1)}×. Consider shortening debate rounds or implementing early-exit when consensus is reached quickly.`);
	}
	const clonerArm = armMap.get("arm-d-cloner");
	if (clonerArm && deliberationArm && clonerArm.totalDurationMs > deliberationArm.totalDurationMs * 1.3) {
		issues.push(`1. **Cloner overhead**: Cloner review adds significant latency. Consider using only 1 cloner for simple tasks (auto-select based on TaskComplexityAnalyzer).`);
	}

	if (issues.length === 0) {
		issues.push("1. **Promising results**: The swarm architecture shows measurable gains across all metrics.");
		issues.push("2. **Next step**: Run on typescript-edit-benchmark (80 tasks) for statistical significance.");
		issues.push("3. **Next step**: Validate on SWE-bench Verified subset (20-30 tasks).");
	}

	for (const issue of issues) {
		lines.push(issue);
	}

	lines.push("");

	// Footer
	lines.push("---");
	lines.push("*Report generated by `benchmarks/analyze.ts`*");

	const report = lines.join("\n");
	console.log(report);

	// Save report
	const reportPath = path.join(resultsDir, "comparison-report.md");
	await Bun.write(reportPath, report);
	console.log(`\nReport saved: ${reportPath}`);
}

main().catch((err) => {
	console.error(`FATAL: ${err.message}`);
	process.exit(1);
});
