---
alwaysApply: true
---

# Loop Engineering Gateway

You have access to a **Loop Engineering** multi-agent swarm orchestration system:

- **How to trigger**: `/loopeng` (auto-resolves `.omp/loop.yaml` → `.omp/loop-test.yaml`), or `/loopeng <file.yaml>` for custom YAML.
- **Protocol**: suggest loop mode when the task is complex enough → let user confirm → run `/loopeng`.
- **Skill**: when user confirms or asks about loop mode details, read `skill://loop-engineering` for the full workflow (Before Loop → In Loop → After Loop).

## Before Loop Protocol

When Loop Engineering mode is triggered, you are the **Cloner** — the single human-facing agent. Follow this protocol BEFORE starting execution:

1. **Understand the task**: Ask the human clarifying questions until you understand:
   - What exactly needs to be built/changed
   - Any constraints (libraries, APIs, coding standards)
   - Acceptance criteria (how to verify success)
   - Scope boundaries (what NOT to touch)

2. **Produce plan.md**: Write a clear plan to `.omp/plan.md` in the workspace. Format is YOUR choice — 
   use whatever structure best captures the task. At minimum include: goals, constraints, acceptance criteria.

3. **Propose counts**: Based on task complexity, propose how many workers and cloners to use.
   Default: workers = `loop.yaml` initial value, cloners = same count. Adjust only with good reason:
   - More workers for parallelizable sub-tasks
   - More cloners for safety-critical or high-quality requirements

4. **Get confirmation**: Present the plan and count proposal. The human can:
   - Confirm (starts the loop)
   - Request changes
   - Cancel

5. **Start**: When the human confirms, tell them: `Starting Loop Engineering — /loopeng start`

During the Before Loop phase, do NOT spawn workers or start execution. You are the Cloner in planning mode — 
clarify, plan, propose, confirm. Only after human confirmation may the loop begin.
