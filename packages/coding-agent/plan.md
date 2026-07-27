# Plan: Theatre Graph — Final Integration & Polish

## Overview
Graph engine code is complete and compiles. Three remaining steps: build the binary, fix any runtime issues surfaced by live LLM execution, and populate the TUI graph view with real data.

## Current State
- `swarm.engine` defaults to `"graph"`
- Magic keyword routes to `GraphRunner` via `agent-session.ts`
- `stp swarm run --engine=graph` CLI path wired
- Dashboard has `graphView` rendering but no data source yet
- All 16 tests pass (9 bridge + 7 graph integration)
- **No compiled binary** — `stp` not in PATH

## Phase 1: Build & Bootstrap

- [ ] **Task: Build stp binary**
  - Files: `package.json` (build scripts)
  - Change: Run `bun run build` or equivalent to produce `dist/cli.js`
  - Acceptance: `bun run dist/cli.js` starts the TUI

- [ ] **Task: Verify GraphRunner init via magic keyword**
  - Files: `src/session/agent-session.ts`
  - Change: Smoke test — type `swarm test` in TUI, verify `GraphRunner.init()` completes without error
  - Acceptance: Status line shows swarm phase, no crash

## Phase 2: Runtime Integration Fixes
**Contract:** GraphRunner execution with live LLM must complete Script → Stage → Curtain.

- [ ] **Task: Fix GraphRunner runtime errors from live execution**
  - Files: `src/swarm/graph/graph-runner.ts`, `src/swarm/graph/node-behavior.ts`
  - Change: Run `stp swarm run` with builtin theatre graph, fix any runtime errors (missing services, type mismatches, API key resolution)
  - Acceptance: GraphRunner completes init() and begins node execution without crashing

- [ ] **Task: Enable auto agent count, roundtable, fork, reporter election**
  - Files: `src/swarm/graph/graph-runner.ts`
  - Change: Pass `ircBus`, `auto: true`, `agent_fork` tool, `agentIds` to StageController creation in `#startStage`
  - Acceptance: Workers get role assignment via roundtable, can fork, reporter is elected

## Phase 3: TUI Graph View Data
**Contract:** Dashboard shows DAG visualization when graph mode is active.

- [ ] **Task: Populate StateTracker with graph mode data**
  - Files: `src/swarm/core/state.ts`, `src/swarm/graph/graph-runner.ts`
  - Change: Set `swarmState.mode = "graph"` when GraphRunner runs; build `graphView` from loaded graph definition + agent states
  - Acceptance: Dashboard renders ASCII DAG during graph execution
