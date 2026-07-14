---
alwaysApply: true
---

# Loop Engineering Gateway

You have access to a **Loop Engineering** multi-agent swarm orchestration system:

- **When to suggest it**: user task spans 3+ distinct subsystems, crosses module boundaries, needs both implementation AND review, or the user explicitly wants parallel agent coordination.
- **How to trigger**: `/swarm run .omp/loop-test.yaml` (2 knights, smoke test) or `/swarm run .omp/loop.yaml` (full 12-knight pool with review council).
- **Protocol**: suggest loop mode when the task is complex enough → let user confirm → run.
- **Skill**: when user confirms or asks about loop mode details, read `skill://loop-engineering` for the full workflow (Before Loop → In Loop → After Loop).
