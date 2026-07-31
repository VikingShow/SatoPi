import type { Agent } from "@satopi/pi-agent-core";
import type { AgentToolContext, ToolCallContext } from "@satopi/pi-agent-core";
import type { CustomToolContext } from "../extensibility/custom-tools/types";
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
       }
}

export class ToolContextStore {
	#uiContext: ExtensionUIContext | undefined;
	#hasUI = false;
	#toolNames: string[] = [];
       #agentRuntime: SwarmRuntime | undefined;
       #eventBus: EventBus | undefined;
       #parentAgent: Agent | undefined;

	constructor(private readonly getBaseContext: () => CustomToolContext) {}

       getContext(toolCall?: ToolCallContext): AgentToolContext {
               return {
                       ...this.getBaseContext(),
                       agentRuntime: this.#agentRuntime,
                       ui: this.#uiContext,
                       hasUI: this.#hasUI,
                       toolNames: this.#toolNames,
                       toolCall,
                       eventBus: this.#eventBus,
                       parentAgent: this.#parentAgent,
               };
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
