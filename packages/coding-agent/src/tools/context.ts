import type { AgentToolContext, ToolCallContext } from "@oh-my-pi/pi-agent-core";
import type { AgentRuntime } from "../swarm/agent-runtime";
import type { CustomToolContext } from "../extensibility/custom-tools/types";
import type { ExtensionUIContext } from "../extensibility/extensions/types";

declare module "@oh-my-pi/pi-agent-core" {
	interface AgentToolContext extends CustomToolContext {
		ui?: ExtensionUIContext;
		hasUI?: boolean;
		toolNames?: string[];
		agentRuntime?: AgentRuntime;
		toolCall?: ToolCallContext;
	}
}

export class ToolContextStore {
	#uiContext: ExtensionUIContext | undefined;
	#hasUI = false;
	#toolNames: string[] = [];
	#agentRuntime: AgentRuntime | undefined;

	constructor(private readonly getBaseContext: () => CustomToolContext) {}

	getContext(toolCall?: ToolCallContext): AgentToolContext {
		return {
			...this.getBaseContext(),
			agentRuntime: this.#agentRuntime,
			ui: this.#uiContext,
			hasUI: this.#hasUI,
			toolNames: this.#toolNames,
			toolCall,
		};
	}

	setUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#uiContext = uiContext;
		this.#hasUI = hasUI;
	}

	setAgentRuntime(runtime: AgentRuntime | undefined): void {
		this.#agentRuntime = runtime;
	}
	setToolNames(names: string[]): void {
		this.#toolNames = names;
	}
}
