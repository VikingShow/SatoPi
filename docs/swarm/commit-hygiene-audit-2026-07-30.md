# Commit Hygiene Audit — 2026-07-30

> Branch: `dev` (now `refactor/architecture-unification`)
> Scope: last 15 commits

## Classification Key
- **VALID**: descriptive message, scoped change, references feature/phase
- **MARGINAL**: unclear but not harmful
- **BAD**: gibberish, auto-generated, or misleading

## Results

| Hash | Message | Classification | Reason |
|------|---------|---------------|--------|
| `55bec7f` | fix: resolve all 24 pre-existing TS errors — 0 errors, 508 tests pass | VALID | Clear, scoped |
| `3be260d` | fix: all 508 tests pass — 0 failures | VALID | Clear |
| `82f3c7f` | fix: update tests for AgentRuntime refactor + ScriptBehavior | VALID | Clear |
| `86da5fc` | fix: update test imports + guard setToolContextAgentRuntime | VALID | Clear |
| `e592fb3` | feat(swarm): Phase 5 — Agent Hub swarm phase indicator | VALID | Clear, scoped |
| `c963955` | feat(swarm): Phase 3+5 — todo injection + role profiles | VALID | Clear, scoped |
| `9a8ac6a` | feat(swarm): Phase 2-4 — channel/fork tools global + planner fix + event-driven | VALID | Clear, scoped |
| `00ce36a` | feat(swarm): Phase 1 - native persistent agent spawning + global CommChannel | VALID | Clear, scoped |
| `09f7fad` | feat: migrate swarm infrastructure to src/ top-level | VALID | Clear, scoped |
| `d3e2bf6` | Merge branch 'refactor/swarm-v3-full-cleanup' into dev | VALID | Merge commit |
| `0bcbf72` | **a** | **BAD** | Single character, meaningless |
| `d3673ab` | chore: bump @satopi/pi-utils version to v0.0.2 | VALID | Clear |
| `a9a5f78` | **(raw git status dump)** | **BAD** | Auto-generated git status output as commit message. Substantial refactor (deleted pipeline.ts 541L + swarm-runner.ts 360L) but message is garbage |
| `ab929d3` | refactor: eliminate dual-planner conflict, register hook synchronously | VALID | Clear |
| `56e533b` | **(raw git status dump)** | **BAD** | Auto-generated git status output as commit message |

## BAD commits requiring fix

| Hash | Current Message | Proposed Rewrite |
|------|----------------|-------------------|
| `0bcbf723c5` | `a` | `chore: bump package versions for @satopi/pi-utils v0.0.2` |
| `a9a5f78a89` | `git status dump` | `refactor(swarm): delete pipeline.ts and swarm-runner.ts, consolidate core types` |
| `56e533b47b` | `git status dump` | `chore: untrack plan.md and .stp/ from git` |

## Fix Command

```bash
git rebase -i HEAD~15
# Mark these 3 commits as 'reword', update messages
```

## Summary
- 10 VALID (+ 1 merge commit)
- 0 MARGINAL
- 3 BAD
- All BAD commits contain valid code changes — only the messages need fixing
