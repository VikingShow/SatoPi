{
  "benchmark": "TypeScript Edit Precision Benchmark",
  "fixtures": "80 tasks × 4 difficulty tiers × 20 mutation types × 10 categories",
  "verification": "7/7 tests pass — verification infrastructure healthy",
  "models_tested": 6,
  "key_findings": {
    "top_performer": {
      "model": "claude-haiku-4.5",
      "success": "90%",
      "edit_precision": "88.5%",
      "avg_time": "52.4s",
      "failure_mode": "Timeout-dominant (2 timeouts, 0 ghost runs)",
      "verdict": "S-Tier: Best overall — fast, precise, reliable"
    },
    "hidden_gem": {
      "model": "deepseek-v3.2",
      "success": "55%",
      "edit_precision": "100%",
      "avg_time": "208.6s",
      "failure_mode": "Hallucination-dominant (9 ghost runs, 0 timeouts)",
      "verdict": "When it edits, it's perfect — but it completes without editing 45% of the time"
    },
    "efficiency_winner": {
      "model": "kimi-k2.5",
      "success": "85%",
      "cost_per_success": "11,551 tokens",
      "avg_time": "94.9s",
      "verdict": "Best token economy per successful task — near S-Tier at 40% lower token cost than haiku"
    },
    "correlations": {
      "success_vs_ghost_runs": "r = −0.868 — ghost runs are THE dominant failure predictor",
      "success_vs_avg_time": "r = −0.953 — slower models fail more",
      "success_vs_edit_precision": "r = −0.535 — raw edit precision does NOT predict task success",
      "success_vs_token_output": "r = −0.578 — verbose output correlates with failure"
    },
    "failure_patterns": {
      "hallucination_models": "deepseek-v3.2 (9 ghost), glm-4.7 (3 ghost)",
      "timeout_models": "minimax-m2.5 (5), glm-4.7 (4), gemini-3f (3)",
      "immune_models": "haiku-4.5 (0 ghost), minimax-m2.5 (0 ghost)"
    }
  },
  "benchmark_design": {
    "mutation_categories": {
      "operator": 28,
      "structural": 16,
      "literal": 8,
      "access": 4,
      "call": 4,
      "regex": 4,
      "unicode": 4,
      "identifier": 4,
      "duplicate": 4,
      "import": 4
    },
    "difficulty_progression": {
      "easy": {
        "avg_lines": 81,
        "repeated_line_pct": "0%",
        "avg_similar_blocks": 2.1
      },
      "medium": {
        "avg_lines": 190,
        "repeated_line_pct": "10%",
        "avg_similar_blocks": 3
      },
      "hard": {
        "avg_lines": 448,
        "repeated_line_pct": "5%",
        "avg_similar_blocks": 11.5
      },
      "nightmare": {
        "avg_lines": 430,
        "repeated_line_pct": "95%",
        "avg_similar_blocks": 10.5
      }
    },
    "design_note": "Nightmare tier is NOT about file size — it's about line ambiguity: 95% of nightmare tasks use repeated lines to force the model to identify the correct edit location without a line number hint."
  },
  "recommendations": [
    "Investigate deepseek-v3.2's ghost-run pathology: 100% edit precision but 55% success suggests it needs better task-completion prompting or turn-limit enforcement",
    "Monitor timeout rates: 5 models lost runs to timeouts; consider raising per-task timeout for the slowest models (glm-4.7, minimax-m2.5)",
    "Add 'task-understood' check: deepseek's 9 ghost runs (completing without editing) could be caught with a pre-flight validation step",
    "Benchmark next: sonnet-4.6, gemini-3-flash (full), glm-5-turbo — these are commented out in the runner and would complete the tier picture"
  ]
}