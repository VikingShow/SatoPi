/**
 * CustomToolAdapter wraps CustomTool instances into AgentTool for use with the agent.
 */
import type { AgentTool, AgentToolUpdateCallback } from "@satopi/pi-agent-core";
import type { Static, TSchema } from "@satopi/pi-ai";
import type { Theme } from "../../modes/theme/theme";
import { applyToolProxy } from "../tool-proxy";
import type { CustomTool, CustomToolContext } from "./types";

export class CustomToolAdapter<TParams extends TSchema = TSchema, TDetails = any, TTheme extends Theme = Theme>
	implements AgentTool<TParams, TDetails, TTheme>
{
	declare name: string;
	declare label: string;
	declare description: string;
	declare parameters: TParams;
	readonly strict: boolean | undefined;

	/**
	 * Auto-classified approval tier (SP-8).
	 *
	 * Classification is system-assigned, not tool-author declared:
	 *   - "read"  — read-only operations (data retrieval, inspection)
	 *   - "write" — mutating operations (file writes, edits, config changes)
	 *   - "exec"  — code/command execution (default, most restrictive)
	 *
	 * Currently defaults the tool's declared tier (e.g. MCP tools hard-code "write"),
	 * falling back to "exec" when undeclared. Future refinement will auto-classify
	 * based on the tool's parameter schema and declared capabilities rather than
	 * trusting self-declaration.
	 */
	readonly approval: AgentTool["approval"];

	constructor(
		private tool: CustomTool<TParams, TDetails>,
		private getContext: () => CustomToolContext,
	) {
		// Assign system-validated approval before applyToolProxy so the proxy
		// skips the tool's raw `approval` field (SP-8: system-assigned, not
		// author-declared). MCP tools hard-code "write" which we preserve;
		// undeclared tools default to "exec" for safety.
		const declared = tool.approval;
		this.approval = declared != null ? declared : ("exec" as const);

		applyToolProxy(tool, this);
		this.strict = tool.strict;
	}

	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParams>,
		context?: CustomToolContext,
	) {
		return this.tool.execute(toolCallId, params, onUpdate, context ?? this.getContext(), signal);
	}

	/**
	 * Backward-compatible export of factory function for existing callers.
	 * Prefer CustomToolAdapter constructor directly.
	 */
	static wrap<TParams extends TSchema = TSchema, TDetails = any, TTheme extends Theme = Theme>(
		tool: CustomTool<TParams, TDetails>,
		getContext: () => CustomToolContext,
	): AgentTool<TParams, TDetails, TTheme> {
		return new CustomToolAdapter(tool, getContext);
	}
}
