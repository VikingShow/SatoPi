/**
 * Agent discovery from filesystem.
 *
 * Discovers agent definitions from OMP-native task-agent roots:
 *   - ~/.stp/agent/agents/*.md (user-level)
 *   - .stp/agents/*.md (project-level)
 *   - <ext>/agents/*.md for every OMP extension package wired through
 *     `listOmpExtensionRoots` (CLI `--extension` roots, `extensions:` in
 *     settings, and enabled npm/link plugins under `<plugins>/node_modules/`).
 *     Mirrors the same sub-discovery convention applied to `skills/`,
 *     `hooks/`, `tools/`, etc. by `discovery/omp-plugins.ts`.
 *
 * Claude Code marketplace plugin agents are discovered separately via the
 * claude-plugins provider. Direct cross-harness roots such as .claude/agents
 * are intentionally skipped because their frontmatter schema is not the OMP
 * task-agent contract.
 *
 * Agent files use markdown with YAML frontmatter.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { RoleAssetManager } from "../agent/role-asset";
import { isProviderEnabled } from "../capability";
import { findAllNearestProjectConfigDirs, getConfigDirs } from "../config";
import { listOmpExtensionRoots } from "../discovery/extension-roots";
import { listClaudePluginRoots } from "../discovery/helpers";
import { loadBundledAgents, parseAgent, roleToAgentDefinition } from "./agents";
import type { AgentDefinition, AgentSource } from "./types";

const TASK_AGENT_CONFIG_SOURCE = ".omp";

/** Result of agent discovery */
export interface DiscoveryResult {
	agents: AgentDefinition[];
	projectAgentsDir: string | null;
}

/**
 * Load agents from a directory.
 */
async function loadAgentsFromDir(dir: string, source: AgentSource): Promise<AgentDefinition[]> {
	const results: AgentDefinition[] = [];
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

	const mdEntries = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name));

	const reads = mdEntries.map(async file => {
		const filePath = path.join(dir, file.name);
		try {
			const agent = await parseAgent(filePath, await fs.readFile(filePath, "utf-8"), source, "warn");
			if (agent) results.push(agent);
		} catch (error) {
			logger.warn("Failed to read agent file", { filePath, error });
		}
	});

	await Promise.all(reads);

	for (const entry of entries) {
		if (entry.isDirectory()) {
			const fullPath = path.join(dir, entry.name);
			const subResults = await loadAgentsFromDir(fullPath, source);
			results.push(...subResults);
		}
	}

	return results;
}

/**
 * Discover agents from filesystem and merge with bundled agents.
 * Precedence (highest wins): project `.stp/agents`, user `.stp/agents`,
 * OMP extension-package agents in `listOmpExtensionRoots` source order
 * (CLI roots > project `extensions:` settings > user `extensions:` settings >
 * installed npm/link plugins), Claude marketplace plugin agents (project
 * scope before user), then bundled.
 * @param cwd - Current working directory for project agent discovery
 */
export async function discoverAgents(cwd: string, home: string = os.homedir()): Promise<DiscoveryResult> {
	const resolvedCwd = path.resolve(cwd);

	const userDirs = getConfigDirs("agents", { project: false })
		.filter(entry => entry.source === TASK_AGENT_CONFIG_SOURCE)
		.map(entry => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	const projectDirs = findAllNearestProjectConfigDirs("agents", resolvedCwd)
		.filter(entry => entry.source === TASK_AGENT_CONFIG_SOURCE)
		.map(entry => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	const orderedDirs: Array<{ dir: string; source: AgentSource }> = [];
	const project = projectDirs[0];
	if (project) orderedDirs.push({ dir: project.path, source: "project" });
	const user = userDirs[0];
	if (user) orderedDirs.push({ dir: user.path, source: "user" });

	// OMP extension-package agents/ dirs. `listOmpExtensionRoots` returns roots in
	// source-precedence order (CLI > project `extensions:` settings > user
	// `extensions:` settings > installed npm/link plugins, with marketplace
	// installs already excluded by realpath) — consume that order verbatim so the
	// `task` agent surface dedups identically to the sibling skills/hooks/tools
	// surface in `discovery/omp-plugins.ts`. Gate on `omp-plugins` so
	// disabledProviders suppresses the whole extension-package surface.
	const extensionRoots = isProviderEnabled("omp-plugins")
		? await listOmpExtensionRoots({ cwd: resolvedCwd, home, repoRoot: null })
		: [];
	for (const root of extensionRoots) {
		orderedDirs.push({ dir: path.join(root.path, "agents"), source: root.level });
	}

	// Load agents from Claude Code marketplace plugins (respects disabledProviders)
	const { roots: pluginRoots } = isProviderEnabled("claude-plugins")
		? await listClaudePluginRoots(home, resolvedCwd)
		: { roots: [] };
	const sortedPluginRoots = [...pluginRoots].sort((a, b) => {
		if (a.scope === b.scope) return 0;
		return a.scope === "project" ? -1 : 1;
	});
	for (const plugin of sortedPluginRoots) {
		const agentsDir = path.join(plugin.path, "agents");
		orderedDirs.push({ dir: agentsDir, source: plugin.scope === "project" ? "project" : "user" });
	}

	const seen = new Set<string>();
	const loadedAgents = (await Promise.all(orderedDirs.map(({ dir, source }) => loadAgentsFromDir(dir, source))))
		.flat()
		.filter(agent => {
			if (seen.has(agent.name)) return false;
			seen.add(agent.name);
			return true;
		});

	// Scan roles/*.role.yaml for RoleAsset→AgentDefinition conversions.
	// Role-based agents do NOT override .md agents with the same name.
	const roleManager = new RoleAssetManager(cwd);
	const roleAgents: AgentDefinition[] = [];
	try {
		const roleSummaries = await roleManager.list();
		for (const summary of roleSummaries) {
			if (seen.has(summary.id)) continue;
			const role = await roleManager.get(summary.id);
			if (!role) continue;
			try {
				const agent = roleToAgentDefinition(role);
				seen.add(agent.name);
				roleAgents.push(agent);
			} catch (err) {
				logger.warn("Failed to convert role to agent definition", { roleId: summary.id, error: err });
			}
		}
	} catch (err) {
		logger.warn("Failed to scan roles directory", { error: err });
	}

	const bundledAgents = loadBundledAgents().filter(agent => {
		if (seen.has(agent.name)) return false;
		seen.add(agent.name);
		return true;
	});

	const projectAgentsDir = projectDirs.length > 0 ? projectDirs[0].path : null;

	return { agents: [...loadedAgents, ...roleAgents, ...bundledAgents], projectAgentsDir };
}

/**
 * Get an agent by name from discovered agents.
 */
export function getAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
	return agents.find(a => a.name === name);
}
