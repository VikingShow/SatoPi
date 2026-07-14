---
alwaysApply: true
---

# Loop Engineering Gateway

You have access to a **Loop Engineering** multi-agent swarm orchestration system:

- **How to trigger**: `/loopeng` (auto-resolves `.omp/loop.yaml` → `.omp/loop-test.yaml`), or `/loopeng <file.yaml>` for custom YAML.
- **Protocol**: suggest loop mode when the task is complex enough → let user confirm → run `/loopeng`.
- **Skill**: when user confirms or asks about loop mode details, read `skill://loop-engineering` for the full workflow (Before Loop → In Loop → After Loop).
