---
name: after-loop-summary
description: "After Loop double-layer experience summarization — knights summarize execution lessons, reviewers distill review insights"
---
# After Loop Summary Skill

## Purpose
After each Loop Engineering cycle completes, run a two-layer retrospective.

## Layer 1: Knight Workshop (Execution Lessons)
1. Summon all knights that participated in this loop iteration.
2. Each knight answers via `irc`:
   - What went well?
   - What went wrong?
   - What would you do differently next time?
   - What did you learn about your capability boundaries?
3. Aggregate answers into `structured_experiences.json`.

## Layer 2: Council Discussion (Review Insights)
1. Summon all reviewers (core + optional) that participated.
2. Each reviewer answers via `irc`:
   - What pattern of issues did you see across the codebase?
   - Which knight produced the highest quality output?
   - What review heuristic would you add for next time?
3. Aggregate into review insights appended to `structured_experiences.json`.

## Emergence Archive
Record emergence observations from the BidAssigner's `EmergenceReport`:
- Cross-capability tasks observed
- Load balance statistics
- Orphaned task count and resolution

## Storage
- Machine-readable: `structured_experiences.json` (Mnemopi-indexed)
- Human-readable: append distilled lessons to `SKILL.md` for context injection into future sessions
