/**
 * Metaharness Experiment Registration Script
 *
 * 注册所有消融实验 arm 到 metaharness store，
 * 使各 arm 的 benchmark 结果能在 metaharness dashboard 中按 experiment 分组对比。
 *
 * 使用方式：
 *   bun run benchmarks/register-experiments.ts
 */

import { RunStore } from "../packages/metaharness/src/store";

const EXPERIMENT_ID = "sato-ablation";
const STORE_DIR = ".metaharness-jobs";

interface AblationArm {
	label: string;
	role: "baseline" | "variant";
	note: string;
	config: Record<string, unknown>;
	yamlPath: string;
}

const ARMS: AblationArm[] = [
	{
		label: "arm-a-baseline",
		role: "baseline",
		note: "ReAct baseline: 1 worker, no deliberation, no cloner",
		config: { workerCount: 1, deliberation: false, clonerCount: 0, dynamicScaling: false },
		yamlPath: "benchmarks/configs/arm-a-baseline.yaml",
	},
	{
		label: "arm-b-multi-worker",
		role: "variant",
		note: "3 workers parallel, no deliberation, no cloner",
		config: { workerCount: 3, deliberation: false, clonerCount: 0, dynamicScaling: false },
		yamlPath: "benchmarks/configs/arm-b-multi-worker.yaml",
	},
	{
		label: "arm-c-deliberation",
		role: "variant",
		note: "3 workers + worker deliberation (peer debate), no cloner",
		config: { workerCount: 3, deliberation: true, clonerCount: 0, dynamicScaling: false },
		yamlPath: "benchmarks/configs/arm-c-deliberation.yaml",
	},
	{
		label: "arm-d-cloner",
		role: "variant",
		note: "3 workers + deliberation + cloner review (2 cloners)",
		config: { workerCount: 3, deliberation: true, clonerCount: 2, dynamicScaling: false },
		yamlPath: "benchmarks/configs/arm-d-cloner.yaml",
	},
	{
		label: "arm-e-full",
		role: "variant",
		note: "Full swarm: 2-6 auto-scaled workers + deliberation + cloner + dynamic scaling",
		config: { workerCount: "auto(2-6)", deliberation: true, clonerCount: 2, dynamicScaling: true },
		yamlPath: "benchmarks/configs/arm-e-full.yaml",
	},
];

const store = new RunStore(STORE_DIR);

// Register experiment goal
store.setExperimentGoal(
	EXPERIMENT_ID,
	"SatoPi In-Loop Ablation: \"isolate the value of each swarm mechanism\" — " +
	"compare 1-worker ReAct baseline against progressive swarm features " +
	"(multi-worker, deliberation, cloner, dynamic scaling) on custom coding tasks. " +
	"Metrics: pass@1, indent score, duration.",
);

console.log(`\nExperiment registered: ${EXPERIMENT_ID}`);
console.log(`Goal: SatoPi In-Loop Ablation Study\n`);

// Register each arm as a pre-launched run entry (for dashboard visibility)
for (const arm of ARMS) {
	const jobName = `${EXPERIMENT_ID}-${arm.label}`;
	store.registerLaunch({
		benchmark: "harbor",
		jobName,
		dataset: "custom-tasks",
		agent: "omp",
		models: ["deepseek-v4-pro"],
		pid: process.pid,
		role: arm.role,
		note: arm.note,
		config: arm.config,
	});
	console.log(`  ✓ ${arm.label}: ${arm.role === "baseline" ? "[BASELINE]" : "[variant]"} ${arm.note}`);
}

console.log(`\n✓ ${ARMS.length} arms registered`);
console.log(`  Dashboard: metaharness server will show these grouped under "${EXPERIMENT_ID}"\n`);

store.close();
