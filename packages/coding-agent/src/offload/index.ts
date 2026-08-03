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

export {
	createOffloadAgentHooks,
	type OffloadAgentHooksConfig,
	type OffloadAgentHooksResult,
} from "./agent-hooks";
export {
	type CompactContextConfig,
	type CompactContextResult,
	compactContext,
	DEFAULT_COMPACT_CONFIG,
} from "./compact";
export {
	createOffloadHooks,
	type OffloadHooksConfig,
	type OffloadHooksResult,
} from "./hooks";
export { type IOffloadManager, OffloadManager } from "./manager";
export {
	type MmdInjectConfig,
	MmdInjector,
	type MmdView,
} from "./mermaid/injector";
export {
	type L2MermaidOutput,
	type L2NewEntry,
	type L2ReplaceBlock,
	LlmMermaidSynthesizer,
} from "./mermaid/llm-synthesizer";
export {
	MermaidSynthesizer,
	type MmdSynthesizeInput,
} from "./mermaid/synthesizer";
export {
	getAgentDataDir,
	getArchivedMmdPath,
	getMmdPath,
	getMmdsDir,
	getOffloadDir,
	getOffloadPath,
	getProfilesDir,
	getStatePath,
} from "./paths";
export {
	type AgentOffloadEntry,
	type AgentOffloadSummarizeInput,
	AgentOffloadSummarizer,
} from "./pipeline/agent-summarizer";
export {
	type AttributionEntry,
	type AttributionInput,
	type AttributionOutput,
	type MmdEdge,
	type MmdNode,
	PlanNodeAttributor,
	type PlanPhase,
} from "./pipeline/attributor";
export {
	type DedupEntry,
	type DedupInput,
	Deduplicator,
	type DedupOutput,
	type TaskBoundary,
} from "./pipeline/deduplicator";
export {
	type L15Input,
	type L15Judgment,
	type L15MmdEntry,
	TaskBoundaryJudge,
} from "./pipeline/l15-judge";
export { L1LlmSummarizer, type L1Summary } from "./pipeline/llm-summarizer";
export {
	OffloadPipeline,
	type OffloadPipelineConfig,
} from "./pipeline/pipeline";
export { AgentSummarizer, type SummarizeInput, type SummarizeOutput } from "./pipeline/summarizer";
export { type OffloadEntry, OffloadStore } from "./store";
