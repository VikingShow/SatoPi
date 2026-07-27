# Architectural Verdict — Theatre Graph Remaining Work

## Summary
The plan's **14 tasks across 4 phases** has a sound prioritization framework but undercounts cross-cutting dependencies in 4 tasks and misses **3 critical integration tasks**. The core design (StageController as opaque heavy node, wave scheduling, checkpoint via session.jsonl) is architecturally clean.

---

## What's Right

### 1. Phase 1 (StageController Integration) is the Correct Priority
The current GraphRunner hardcodes `new CustomNodeBehavior()` at `graph-runner.ts:156` — it never calls `selectNodeBehavior()`. ScriptNodeBehavior, StageNodeBehavior, and CurtainNodeBehavior are all stubs delegating to CustomNodeBehavior. Without Phase 1, the theatre graph is just a single-agent-per-node scheduler. StageController provides the actual value: parallel worker spawning, role roundtable, task queue with dependency tracking, deadlock detection. **Phase 1 is non-negotiable as first priority.**

However, the plan fails to mention the one-line fix needed in `confirmScript()`: changing line 156 from `new CustomNodeBehavior()` to `selectNodeBehavior(node.type)`. Without this, StageNodeBehavior.execute() is never reached regardless of how well it's wired.

### 2. StageController as Opaque Heavy Node is Correct
Decomposing StageController into individual graph nodes (one per worker, tasks as edges) would be a major redesign. StageController already handles agent selection, role assignment via roundtable, task queue with dependency tracking, parallel spawning via Promise.all, and deadlock detection. Rebuilding that as graph primitives duplicates complexity with unclear benefit. The wrapper approach (StageNodeBehavior → createStageController → run) preserves the existing investment while integrating with the graph framework.

### 3. Phase Ordering is Logically Sound
Phase 0 (ISwarmOrchestrator) → Phase 1 (engine) → Phase 2 (integrate) → Phase 3 (flip) follows the merge-then-enable pattern. You can't demo a graph TUI without graph execution; can't harden what doesn't run.

Within Phase 1, task ordering (wire StageNodeBehavior → wire IRCBus → enable agent_fork) IS sequential — role roundtable needs IRCBus, and agent_fork testing needs both.

### 4. UXDesigner confirmed: Phase 2 TUI can parallelize with Phase 1
The TUI graph view is purely read-only from GraphRunner state (GraphDefinition topology + StateTracker.agents status). Both are available after GraphRunner initializes in Phase 0/1 regardless of whether StageNodeBehavior is a stub. The TUI doesn't need nodes to execute with graph semantics to render a DAG with status overlays. **Phase 1 and Phase 2 can be executed in parallel.**

### 5. Checkpoint Design is Architecturally Clean
ADR-8's session.jsonl append-only log + replay-based recovery is the right pattern for a single-process orchestrator. No distributed consensus needed. Write after each StateTracker.updateAgent status change — simple, inline, deterministic.

---

## What's Wrong

### 1. NodeContext Doesn't Carry StageController Dependencies (Phase 1 Gap)
The current `NodeContext` interface (`schema.ts:288-305`) carries 7 fields: `node`, `workspace`, `modelRegistry`, `settings`, `upstreamOutputs`, `experience`, `signal`, `runtime`. But StageController needs 12+ fields: `planContent`, `loopConfig`, `profileRegistry`, `commBus`, `ircBus`, `roleAssetManager`, `fsm`, `stateTracker`, `activityLogger`, `callbacks`.

**The plan has no task to extend NodeContext or create an alternative injection path.** The cleanest solution: GraphRunner constructs StageNodeBehavior with constructor DI — GraphRunner already holds all needed services. NodeContext stays minimal; StageNodeBehavior knows how to build StageOptions from constructor-injected services + context fields.

**Recommendation**: Add a Phase 1 task: "Extend StageNodeBehavior constructor to accept StageOptions dependencies from GraphRunner, and generate planContent from upstream script node output."

### 2. GateController Retry Loop is Missing (Phase 3 Underspecification)
`graph-runner.ts:200-206` runs gates once and returns immediately on failure. `GateController.handleGateFailure()` exists but is never called from the execution path. The Phase 3 task "Error propagation and retry wiring" lists gate retries but doesn't specify:
- Where the retry loop lives (in confirmScript's runNode callback, or in GateController itself)
- How retry interacts with WaveScheduler's continue_on_failure detection (lines 82-87)
- Whether retries consume wave time or happen within the same wave

RuntimeVerdict raised this independently and I confirmed it by reading the code.

**Recommendation**: Split into two subtasks: (a) gate retry loop in confirmScript, (b) error propagation across dependents.

### 3. ExperienceStore Graph Scoping Spans 3 Files, Not 1
The plan estimates `experience.ts ~30行`. But the data flow is broken at every level:
- `CurtainRunnerOpts` has no `graphName` field (confirmed by DataVerdict)
- `graph-runner.ts:216-229` calls `runCurtainPipeline` with empty stub data (`agentResults: new Map()`, `errors: []`), never passing real execution results
- The curtain runner's lesson extraction has no path to receive graph metadata
- ExperienceStore already has the columns (migration v2 adds `graph_name`, `node_id`, `task_hash`), just needs INSERT wiring

DataVerdict proposed adding `metadata?: { graphName?, nodeId?, taskHash? }` to `LessonSink.fanOut()` — clean, extensible, keeps sinks decoupled from graph concepts.

**Reality**: ~50 lines across 3 files (curtain-runner.ts, graph-runner.ts, experience.ts). The task should be renamed "Wire graph context through curtain pipeline → experience store."

### 4. GraphEdge is Defined But Never Wired Into Execution (v1 Gap)
Schema.ts defines `GraphEdge { from, to, artifacts, label }`. The YAML parser reads edges. But in execution:
- Waves are built from `node.depends_on` arrays (graph-runner.ts:105-108), not from edges
- Artifact references on edges are never wired into upstream output passing
- Edge labels are stored but never displayed

DataArchitect clarified the intended architecture: `depends_on` controls CONTROL FLOW (B waits for A); `edges` with data_mapping controls DATA FLOW (B receives A's structured output). This requires `UpstreamOutputSource`, a ContextSource at priority 0.5 that reads edge data_mappings and injects `<upstream_context>` XML blocks into downstream agent context. Without this, the theatre graph is "a glorified makefile" — control flow only, no structured data passing. **This is a v1 feature, not deferrable.**

**Recommendation**: Add a Phase 1/2 task: "Wire UpstreamOutputSource into NodeExecutor, reading GraphEdge data_mapping to construct structured upstream context injection."

### 5. WaveScheduler Receives No Node Metadata
WaveScheduler's constructor accepts `nodes?: Record<string, SchedulerNodeInfo>` but GraphRunner passes nothing (line 144: `new WaveScheduler()`). The scheduler's continue_on_failure check at line 82-87 is dead — it always sees an empty map and treats every failure as hard.

**Recommendation**: Phase 3 task: wire per-node continue_on_failure into WaveScheduler constructor.

### 6. LoopSwarmConfig Required by StageController, Absent in Graph Mode
StageController's StageOptions requires `loopConfig: LoopSwarmConfig`, but graph execution has no loop configuration. Either: make loopConfig optional, generate a default from GraphDefinition, or add a graph-to-loop-config bridge. The plan is silent on this.

---

## What's Missing (3 New Tasks)

| # | Task | Phase | Rationale |
|---|---|---|---|
| **NEW-1** | Use `selectNodeBehavior()` in confirmScript's runNode callback | P1 | 1-line fix that unblocks all Phase 1 work. Currently hardcoded to `new CustomNodeBehavior()`. |
| **NEW-2** | Pass real node results to curtain pipeline | P1 or P3 | `graph-runner.ts:216-229` passes empty stub data. Reporter election, reflection, and experience extraction all run on nothing. |
| **NEW-3** | Wire UpstreamOutputSource for GraphEdge data_mapping | P1 or P2 | Edges-as-dataflow is v1-critical per DataArchitect. Without it, the theatre graph has control flow but no structured data passing. |

---

## Full Task Reassessment

| # | Task | Phase | Verdict | Notes |
|---|---|---|---|---|
| **NEW-1** | Use selectNodeBehavior() in confirmScript | **P1** | 🔴 Missing | 1-line fix blocking all P1 |
| 1 | Wire StageNodeBehavior to StageController | P1 | ✅ Critical | Also needs constructor DI for StageOptions |
| 2 | Wire IRCBus through GraphRunner → StageController | P1 | ✅ Follows #1 | |
| 3 | Enable agent_fork in stage node tools | P1 | ✅ Follows #1-2 | |
| **NEW-3** | Wire UpstreamOutputSource for edge data_mapping | **P1/P2** | 🔴 Missing | v1 dataflow feature |
| 4 | Populate graphView from GraphRunner state | P2 | ✅ Independent | Parallelizable with P1 |
| 5 | Register /graph slash commands | P2 | ✅ Independent | Parallelizable with P1 |
| **NEW-2** | Pass real results to curtain pipeline | **P1/P3** | 🔴 Missing | Correctness bug |
| 6 | Checkpoint write on node transitions | P3 | ✅ Correct phase | Simple inline wiring |
| 7 | Error propagation and retry wiring | P3 | ⚠️ Split into 2 | Gate retry loop + error propagation |
| 7a | Wire WaveScheduler node metadata | P3 | ⚠️ Sub-task | continue_on_failure + retry |
| 8 | Token budget per node | P3 | ✅ Correct phase | |
| 9 | Loop converter integration test | P4 | ✅ | |
| 10 | Mermaid compiler integration test | P4 | ✅ | |
| 11 | Builtin theatre graph e2e test | P4 | ✅ | |
| 12 | ExperienceStore graph scoping | P4 | ⚠️ 3 files | Was ~30 lines; actually ~50 across 3 files |
| 13 | Graph YAML validation hardening | P4 | ✅ | |
| 14 | Security — graph YAML sandboxing | P4 | ✅ | |

---

## Revised Implementation Estimate

| Phase | Original | Revised | Delta |
|---|---|---|---|
| 0: Interface | ~80 new / ~30 mod | Same | — |
| 1: Engine | ~900 new / ~50 mod | ~1050 new / ~60 mod | +3 tasks |
| 2: Integrate | ~600 new / ~200 mod | ~700 new / ~220 mod | +edge wiring |
| 3: Reliability | (in Phase 3 combined) | ~350 new / ~100 mod | Split from Phase 2 |
| 4: Polish | ~50 new / ~100 mod | ~80 new / ~120 mod | +curtain wiring fix |
| **Total** | **~1630 new / ~380 mod** | **~2260 new / ~500 mod** | **+630 / +120** |
| **Time** | **~7 days** | **~9 days** | **+2 days** |

---

## IRC Challenges Sent

1. **RuntimeVerdict**: Confirmed gate retry gap + WaveScheduler metadata dead code. Raised question of whether continue_on_failure wiring belongs in Phase 1 or Phase 3.
2. **DataVerdict**: Confirmed ExperienceStore scoping spans 3 files, not 1. Agreed on LessonSink.fanOut metadata slot design.
3. **UXDesigner**: Confirmed Phase 2 TUI can parallelize with Phase 1. Confirmed Mermaid layout ≠ ASCII layout — no duplication concern.
4. **DataArchitect**: Flagged GraphEdge never wired — confirmed this is v1-critical dataflow, not deferrable v2. Need UpstreamOutputSource task.

---

## Conclusion

The plan's prioritization is sound, and the architectural decisions (StageController as opaque node, wave scheduling, session.jsonl checkpointing) are correct. However, **3 missing tasks + 2 underspecified tasks** add ~2 days of work. The biggest risks are: (1) StageNodeBehavior can't construct StageController without missing dependencies, (2) the curtain pipeline runs on empty data, and (3) edge-based dataflow is unimplemented, leaving the system as control-flow-only. Addressing these before Phase 1 execution begins will prevent rework.
