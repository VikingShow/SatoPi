import type { Agent, AgentToolContext, ToolCallContext } from "@satopi/pi-agent-core";
import type { CustomToolContext } from "../extensibility/custom-tools/types";
import type { CommChannel } from "../comm/comm-channel";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import type { SwarmRuntime } from "../swarm/core/swarm-runtime";
import type { EventBus } from "../utils/event-bus";

declare module "@satopi/pi-agent-core" {
	interface AgentToolContext extends CustomToolContext {
		ui?: ExtensionUIContext;
		hasUI?: boolean;
		toolNames?: string[];
		agentRuntime?: SwarmRuntime;
		toolCall?: ToolCallContext;
		eventBus?: EventBus;
		parentAgent?: Agent;
		forkMaxDepth?: number;
	}
}

export class ToolContextStore {
	#uiContext: ExtensionUIContext | undefined;
	#hasUI = false;
	#toolNames: string[] = [];
	#agentRuntime: SwarmRuntime | undefined;
	#eventBus: EventBus | undefined;
	#parentAgent: Agent | undefined;
	#forkMaxDepth: number | undefined;
	#commChannel: CommChannel | undefined;

	constructor(private readonly getBaseContext: () => CustomToolContext) {}

	getContext(toolCall?: ToolCallContext): AgentToolContext {
		return {
			...this.getBaseContext(),
			agentRuntime: this.#agentRuntime,
			commChannel: this.#commChannel,
			ui: this.#uiContext,
			hasUI: this.#hasUI,
			toolNames: this.#toolNames,
			toolCall,
			eventBus: this.#eventBus,
			parentAgent: this.#parentAgent,
			forkMaxDepth: this.#forkMaxDepth,
		};
	}
	setCommChannel(channel: CommChannel | undefined): void {
		this.#commChannel = channel;
	}

	setForkMaxDepth(depth: number | undefined): void {
		this.#forkMaxDepth = depth;
	}

	setUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#uiContext = uiContext;
		this.#hasUI = hasUI;
	}

	setAgentRuntime(runtime: SwarmRuntime | undefined): void {
		this.#agentRuntime = runtime;
	}
	hasAgentRuntime(): boolean {
		return this.#agentRuntime !== undefined;
	}

	setToolNames(names: string[]): void {
		this.#toolNames = names;
	}

	setEventBus(eventBus: EventBus): void {
		this.#eventBus = eventBus;
	}

	setParentAgent(agent: Agent): void {
		this.#parentAgent = agent;
	}
}
