#!/bin/bash
# SatoPi In-Loop Ablation Batch Runner
#
# 在自定义任务上依次运行 5 个消融实验 arm（A-E），收集全部结果。
#
# 使用方式：
#   chmod +x benchmarks/run-ablation.sh
#   ./benchmarks/run-ablation.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TASK_DIR="${PROJECT_ROOT}/benchmarks/custom-tasks"
RESULTS_DIR="${PROJECT_ROOT}/benchmarks/results"
CONFIG_DIR="${PROJECT_ROOT}/benchmarks/configs"
MODEL="deepseek-v4-pro"

# Ensure results dir exists
mkdir -p "$RESULTS_DIR"

run_arm() {
    local arm_label="$1"
    local yaml_path="$2"

    echo ""
    echo "################################################################"
    echo "# ARM: ${arm_label}"
    echo "# YAML: ${yaml_path}"
    echo "# Model: ${MODEL}"
    echo "################################################################"
    echo ""

    (cd "$PROJECT_ROOT" && bun run benchmarks/in-loop-runner.ts \
        --task-dir "$TASK_DIR" \
        --loop-yaml "$yaml_path" \
        --arm "$arm_label" \
        --experiment "sato-ablation" \
        --model "$MODEL" \
        --output-dir "$RESULTS_DIR" \
        --store-dir ".metaharness-jobs" \
        2>&1 | tee "${RESULTS_DIR}/${arm_label}.log")

    echo ""
    echo "✓ ${arm_label} complete. Log: ${RESULTS_DIR}/${arm_label}.log"
}

echo ""
echo "=================================="
echo " SatoPi In-Loop Ablation Runner"
echo "=================================="
echo " Tasks:   ${TASK_DIR}"
echo " Results: ${RESULTS_DIR}"
echo " Model:   ${MODEL}"
echo ""

# Register experiment metadata first
echo "[0/5] Registering experiment metadata..."
(cd "$PROJECT_ROOT" && bun run benchmarks/register-experiments.ts)

# Arm A: ReAct Baseline
run_arm "arm-a-baseline" "${CONFIG_DIR}/arm-a-baseline.yaml"

# Arm B: Multi-worker, no deliberation
run_arm "arm-b-multi-worker" "${CONFIG_DIR}/arm-b-multi-worker.yaml"

# Arm C: Deliberation enabled
run_arm "arm-c-deliberation" "${CONFIG_DIR}/arm-c-deliberation.yaml"

# Arm D: Deliberation + Cloner
run_arm "arm-d-cloner" "${CONFIG_DIR}/arm-d-cloner.yaml"

# Arm E: Full (dynamic scaling)
run_arm "arm-e-full" "${CONFIG_DIR}/arm-e-full.yaml"

# Generate comparison report
echo ""
echo "=================================="
echo " Generating Comparison Report..."
echo "=================================="
(cd "$PROJECT_ROOT" && bun run benchmarks/analyze.ts --results-dir "$RESULTS_DIR")

echo ""
echo "✓ All ablation runs complete!"
echo "  Results: ${RESULTS_DIR}/"
echo "  Summary: ${RESULTS_DIR}/comparison-report.md"
