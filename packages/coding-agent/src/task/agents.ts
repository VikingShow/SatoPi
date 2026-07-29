/**
 * Bundled agent definitions.
 *
 * Agents are embedded at build time via Bun's import with { type: "text" }.
 */
import { Effort } from "@satopi/pi-ai";
import { parseFrontmatter, prompt } from "@satopi/pi-utils";
import type { RoleAsset } from "../agent/role-asset";
import { parseAgentFields } from "../discovery/helpers";
import designerMd from "../prompts/agents/designer.md" with { type: "text" };
// Embed agent markdown files at build time
import agentFrontmatterTemplate from "../prompts/agents/frontmatter.md" with { type: "text" };
import librarianMd from "../prompts/agents/librarian.md" with { type: "text" };
import reviewerMd from "../prompts/agents/reviewer.md" with { type: "text" };
import scoutMd from "../prompts/agents/scout.md" with { type: "text" };
import swarmMd from "../prompts/agents/swarm.md" with { type: "text" };
import taskMd from "../prompts/agents/task.md" with { type: "text" };
import { AUTO_THINKING, parseConfiguredThinkingLevel } from "../thinking";

import type { AgentDefinition, AgentSource } from "./types";

interface AgentFrontmatter {
	name: string;
	description: string;
	tools?: string[];
	spawns?: string;
	model?: string | string[];
	thinkingLevel?: string;
	blocking?: boolean;
}

interface EmbeddedAgentDef {
	fileName: string;
	frontmatter?: AgentFrontmatter;
	template: string;
}

function buildAgentContent(def: EmbeddedAgentDef): string {
	const body = prompt.render(def.template);
	if (!def.frontmatter) return body;
	return prompt.render(agentFrontmatterTemplate, { ...def.frontmatter, body });
}

const EMBEDDED_AGENT_DEFS: EmbeddedAgentDef[] = [
	{ fileName: "scout.md", template: scoutMd },
	{ fileName: "designer.md", template: designerMd },
	{ fileName: "reviewer.md", template: reviewerMd },
	{ fileName: "librarian.md", template: librarianMd },
	{
		fileName: "task.md",
		frontmatter: {
			name: "task",
			description: "General-purpose subagent with full capabilities for delegated multi-step tasks",
			spawns: "*",
			model: "@task",
			thinkingLevel: AUTO_THINKING,
		},
		template: taskMd,
	},
	{
		fileName: "sonic.md",
		frontmatter: {
			name: "sonic",
			description: "Low-reasoning agent for strictly mechanical updates or data collection only",
			model: "@smol",
			thinkingLevel: Effort.Medium,
		},
		template: taskMd,
	},
	{ fileName: "swarm.md", template: swarmMd },
];

// Computed lazily on first loadBundledAgents() call to avoid eager prompt.render at module load.

export class AgentParsingError extends Error {
	constructor(
		error: Error,
		readonly source?: unknown,
	) {
		super(`Failed to parse agent: ${error.message}`, { cause: error });
		this.name = "AgentParsingError";
	}

	toString(): string {
		const details: string[] = [this.message];
		if (this.source !== undefined) {
			details.push(`Source: ${JSON.stringify(this.source)}`);
		}
		if (this.cause && typeof this.cause === "object" && "stack" in this.cause && this.cause.stack) {
			details.push(`Stack:\n${this.cause.stack}`);
		} else if (this.stack) {
			details.push(`Stack:\n${this.stack}`);
		}
		return details.join("\n\n");
	}
}

/**
 * Parse an agent from embedded content.
 */
export function parseAgent(
	filePath: string,
	content: string,
	source: AgentSource,
	level: "fatal" | "warn" | "off" = "fatal",
): AgentDefinition {
	const { frontmatter, body } = parseFrontmatter(content, {
		location: filePath,
		level,
	});
	const fields = parseAgentFields(frontmatter);
	if (!fields) {
		throw new AgentParsingError(new Error(`Invalid agent field: ${filePath}\n${content}`), filePath);
	}
	return {
		...fields,
		systemPrompt: body,
		source,
		filePath,
	};
}

/** Cache for bundled agents */
let bundledAgentsCache: AgentDefinition[] | null = null;

/**
 * Load all bundled agents from embedded content.
 * Results are cached after first load.
 */
export function loadBundledAgents(): AgentDefinition[] {
	if (bundledAgentsCache !== null) {
		return bundledAgentsCache;
	}
	bundledAgentsCache = EMBEDDED_AGENT_DEFS.map(def =>
		parseAgent(`embedded:${def.fileName}`, buildAgentContent(def), "bundled"),
	);
	return bundledAgentsCache;
}

/**
 * Get a bundled agent by name.
 */
export function getBundledAgent(name: string): AgentDefinition | undefined {
	return loadBundledAgents().find(a => a.name === name);
}

/**
 * Get all bundled agents as a map keyed by name.
 */
export function getBundledAgentsMap(): Map<string, AgentDefinition> {
	const map = new Map<string, AgentDefinition>();
	for (const agent of loadBundledAgents()) {
		map.set(agent.name, agent);
	}
	return map;
}

/**
 * Clear the bundled agents cache (for testing).
export function clearBundledAgentsCache(): void {
	bundledAgentsCache = null;
}

/**
 * Convert a RoleAsset to an AgentDefinition.
 * Maps role fields to agent contract: id→name, system prompt, guidelines, tools, model, etc.
 */
export function roleToAgentDefinition(role: RoleAsset): AgentDefinition {
	let systemPrompt = role.prompts.system;

	// Append guidelines block if present
	if (role.prompts.guidelines && role.prompts.guidelines.length > 0) {
		const guidelinesBlock = role.prompts.guidelines.map(g => `- ${g}`).join("\n");
		systemPrompt = `${systemPrompt}\n\n## Guidelines\n${guidelinesBlock}`;
	}

	return {
		name: role.id,
		description: role.description,
		systemPrompt,
		tools: role.tools.length > 0 ? role.tools : undefined,
		model: role.model ? [role.model] : undefined,
		thinkingLevel: role.thinkingLevel ? parseConfiguredThinkingLevel(role.thinkingLevel) : undefined,
		output: role.output,
		spawns: role.spawns
			? role.spawns === "*"
				? "*"
				: role.spawns
						.split(",")
						.map(s => s.trim())
						.filter(Boolean)
			: undefined,
		blocking: role.blocking,
		source: "project",
	};
}

// Re-export for backward compatibility
export const BUNDLED_AGENTS = loadBundledAgents;
