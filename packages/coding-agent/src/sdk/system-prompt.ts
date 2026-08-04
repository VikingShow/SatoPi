/**
 * sdk/system-prompt.ts — public system-prompt builder for the SDK entry point
 * (stage 4 split). Extracted from src/sdk.ts.
 */

import type { Skill } from "../extensibility/skills";
import {
	type BuildSystemPromptResult,
	buildSystemPrompt as buildSystemPromptInternal,
	buildSystemPromptToolMetadata,
} from "../system-prompt";
import type { Tool } from "../tools";

export interface BuildSystemPromptOptions {
	tools?: Tool[];
	skills?: Skill[];
	contextFiles?: Array<{ path: string; content: string }>;
	cwd?: string;
	customPrompt?: string;
	appendPrompt?: string;
	inlineToolDescriptors?: boolean;
	includeWorkspaceTree?: boolean;
}

/**
 * Build the default provider-facing system prompt blocks.
 *
 * The returned `systemPrompt` preserves the stable harness prompt and dynamic project context
 * as separate entries so providers can cache prompt prefixes without concatenating blocks.
 */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	const toolMap = options.tools ? new Map(options.tools.map(tool => [tool.name, tool])) : undefined;
	return await buildSystemPromptInternal({
		cwd: options.cwd,
		customPrompt: options.customPrompt,
		skills: options.skills,
		contextFiles: options.contextFiles,
		appendSystemPrompt: options.appendPrompt,
		inlineToolDescriptors: options.inlineToolDescriptors,
		includeWorkspaceTree: options.includeWorkspaceTree,
		toolNames: options.tools?.map(tool => tool.name),
		tools: toolMap ? buildSystemPromptToolMetadata(toolMap) : undefined,
	});
}
