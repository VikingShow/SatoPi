#!/bin/bash
# Competitor Comparison Runner
#
# 在同任务集上运行 Aider，与 SatoPi 最佳配置对标。
#
# 前置条件：pip install aider-chat
#
# 使用方式：
#   chmod +x benchmarks/run-competitor.sh
#   ./benchmarks/run-competitor.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TASK_DIR="${PROJECT_ROOT}/benchmarks/custom-tasks"
RESULTS_DIR="${PROJECT_ROOT}/benchmarks/results"

# Check aider availability
if ! command -v aider &> /dev/null; then
    echo "WARNING: 'aider' not found in PATH. Attempting pip install..."
    pip install aider-chat || {
        echo "ERROR: Cannot install aider. Please install manually: pip install aider-chat"
        exit 1
    }
fi

echo ""
echo "=================================="
echo " Competitor Comparison: Aider"
echo "=================================="
echo " Model: deepseek/deepseek-chat"
echo " Tasks: ${TASK_DIR}"
echo ""

(cd "$PROJECT_ROOT" && bun run benchmarks/competitor-runner.ts \
    --task-dir "$TASK_DIR" \
    --arm "aider-deepseek" \
    --experiment "sato-competitor" \
    --model "deepseek/deepseek-chat" \
    --output-dir "$RESULTS_DIR" \
    2>&1 | tee "${RESULTS_DIR}/aider-deepseek.log")

echo ""
echo "✓ Aider comparison complete!"
echo "  Log: ${RESULTS_DIR}/aider-deepseek.log"
echo ""
echo "To compare against SatoPi results, run:"
echo "  bun run benchmarks/analyze.ts --results-dir ${RESULTS_DIR}"
