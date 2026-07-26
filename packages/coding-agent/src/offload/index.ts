/**
 * offload/ — TencentDB-Agent-Memory Mermaid progressive disclosure engine
 *
 * L1→L1.5→L2→L3 pipeline for context offload.
 *
 * Usage (loop-controller.ts — zero modification):
 *
 *   import { createOffloadHooks } from "./offload";
 *   const hooks = createOffloadHooks(workspace, agentName, storage, config);
 *   runLoop({ hooks });
 */

export { OffloadStore, type OffloadEntry } from "./store";
export {
	getOffloadDir,
	getAgentDataDir,
	getMmdsDir,
	getOffloadPath,
	getMmdPath,
	getArchivedMmdPath,
	getStatePath,
	getProfilesDir,
} from "./paths";
export {
	OffloadPipeline,
	type OffloadPipelineConfig,
} from "./pipeline/pipeline";
export { AgentSummarizer, type SummarizeInput, type SummarizeOutput } from "./pipeline/summarizer";
export { L1LlmSummarizer, type L1Summary } from "./pipeline/llm-summarizer";
export { OffloadManager, NoopOffloadManager, type IOffloadManager } from "./manager";
export {
	Deduplicator,
	type DedupEntry,
	type DedupInput,
	type DedupOutput,
	type TaskBoundary,
} from "./pipeline/deduplicator";
export {
	TaskBoundaryJudge,
	type L15Judgment,
	type L15MmdEntry,
	type L15Input,
} from "./pipeline/l15-judge";
export {
	PlanNodeAttributor,
	type PlanPhase,
	type AttributionEntry,
	type AttributionInput,
	type AttributionOutput,
	type MmdNode,
	type MmdEdge,
} from "./pipeline/attributor";
export {
	MermaidSynthesizer,
	type MmdSynthesizeInput,
} from "./mermaid/synthesizer";
export {
	LlmMermaidSynthesizer,
	type L2NewEntry,
	type L2MermaidOutput,
	type L2ReplaceBlock,
} from "./mermaid/llm-synthesizer";
export {
	MmdInjector,
	type MmdInjectConfig,
	type MmdView,
} from "./mermaid/injector";
export {
	createOffloadHooks,
	type OffloadHooksConfig,
	type OffloadHooksResult,
} from "./hooks";
export {
	createOffloadAgentHooks,
	type OffloadAgentHooksConfig,
	type OffloadAgentHooksResult,
} from "./agent-hooks";
export {
	AgentOffloadSummarizer,
	type AgentOffloadEntry,
	type AgentOffloadSummarizeInput,
} from "./pipeline/agent-summarizer";
export {
	compactContext,
	DEFAULT_COMPACT_CONFIG,
	type CompactContextConfig,
	type CompactContextResult,
} from "./compact";
