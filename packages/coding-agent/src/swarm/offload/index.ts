/**
 * offload/ — TencentDB-Agent-Memory Mermaid progressive disclosure engine
 *
 * L1→L1.5→L2→L3 pipeline for swarm context offload.
 *
 * Usage (loop-controller.ts — zero modification):
 *
 *   import { createOffloadHooks } from "./offload";
 *   const hooks = createOffloadHooks(swarmDir, storage, config);
 *   runLoop({ hooks });
 */

export { SwarmOffloadStore, type SwarmOffloadEntry } from "./offload-store";
export {
	getOffloadDir,
	getMmdsDir,
	getRefsDir,
	getOffloadPath,
	getMmdPath,
	getArchivedMmdPath,
} from "./offload-paths";
export {
	OffloadPipeline,
	type OffloadPipelineConfig,
} from "./offload-pipeline";
export { WorkerSummarizer, type SummarizeInput, type SummarizeOutput } from "./worker-summarizer";
export {
	Deduplicator,
	type DedupEntry,
	type DedupInput,
	type DedupOutput,
	type TaskBoundary,
} from "./deduplicator";
export {
	PlanNodeAttributor,
	type PlanPhase,
	type AttributionEntry,
	type AttributionInput,
	type AttributionOutput,
	type MmdNode,
	type MmdEdge,
} from "./plan-node-attributor";
export {
	MermaidSynthesizer,
	type MmdSynthesizeInput,
} from "./mermaid-synthesizer";
export {
	MmdInjector,
	type MmdInjectConfig,
	type MmdView,
} from "./mmd-injector";
export {
	createOffloadHooks,
	type OffloadHooksConfig,
	type OffloadHooksResult,
} from "./offload-hooks";
