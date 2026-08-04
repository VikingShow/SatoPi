/**
 * sdk/discovery.ts — environment-discovery helpers for the SDK entry point
 * (stage 4 split). Extracted from src/sdk.ts.
 */
import { getAgentDir, getProjectDir, logger } from "@satopi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { loadPromptTemplates as loadPromptTemplatesInternal, type PromptTemplate } from "../config/prompt-templates";
import type { Settings, SkillsSettings } from "../config/settings";
import {
	type CustomCommandsLoadResult,
	loadCustomCommands as loadCustomCommandsInternal,
} from "../extensibility/custom-commands";
import {
	discoverAndLoadExtensions,
	discoverExtensionPaths,
	type LoadExtensionsResult,
	loadExtensions,
} from "../extensibility/extensions";
import { loadSkills as loadSkillsInternal, type Skill, type SkillWarning } from "../extensibility/skills";
import { type FileSlashCommand, loadSlashCommands as loadSlashCommandsInternal } from "../extensibility/slash-commands";
import { discoverAndLoadMCPTools, type MCPToolsLoadResult } from "../mcp";
import { discoverAuthStorage as discoverAuthStorageFromConfig } from "../session/auth/auth-broker-config";
import type { AuthStorage } from "../session/auth/auth-storage";
import { loadProjectContextFiles as loadContextFilesInternal } from "../system-prompt";
import { EventBus } from "../utils/event-bus";

/** The subset of CreateAgentSessionOptions the discovery helpers read. */
export interface DiscoverySessionOptions {
	disableExtensionDiscovery?: boolean;
	additionalExtensionPaths?: string[];
}

/**
 * Create an AuthStorage instance.
 *
 * Default: local SQLite store at `<agentDir>/agent.db`.
 *
 * Broker mode: when `STP_AUTH_BROKER_URL` is set, credentials are pulled from
 * a remote auth-broker over the wire. Refresh tokens never leave the broker;
 * the client receives access tokens with `refresh = "__remote__"` and calls
 * back into the broker through the {@link AuthStorageOptions.refreshOAuthCredential}
 * override to re-mint access tokens when needed.
 *
 * Delegates to {@link ./session/auth-broker-config} so the TUI and the catalog
 * generator share the same credential-discovery logic.
 */
export async function discoverAuthStorage(agentDir: string = getAgentDir()): Promise<AuthStorage> {
	return discoverAuthStorageFromConfig(agentDir);
}

/**
 * Discover extensions from cwd.
 */
export async function discoverExtensions(cwd?: string): Promise<LoadExtensionsResult> {
	const resolvedCwd = cwd ?? getProjectDir();

	return discoverAndLoadExtensions([], resolvedCwd);
}

/**
 * Path-only counterpart of {@link loadSessionExtensions}: the FS-heavy scan
 * without the per-session module load. Subagents reuse the parent's path list
 * (cached on {@link ToolSession.extensionPaths}) and rebuild Extension
 * instances themselves so each session's `ExtensionAPI` (cwd, eventBus,
 * runtime) is its own.
 */
export async function discoverSessionExtensionPaths(
	options: DiscoverySessionOptions,
	cwd: string,
	settings: Settings,
): Promise<string[]> {
	if (options.disableExtensionDiscovery) {
		return options.additionalExtensionPaths ?? [];
	}
	const configuredPaths = [...(options.additionalExtensionPaths ?? []), ...(settings.get("extensions") ?? [])];
	const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
	return discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds);
}

/**
 * Load the discovered/configured extensions for a session — everything {@link
 * createAgentSession} would load except the inline factory extensions it appends
 * itself. Extracted so the CLI can resolve extension-registered flags (and thus
 * classify `@file` arguments extension-aware) *before* a session — and its
 * terminal breadcrumb — is created, then hand the result back through
 * {@link CreateAgentSessionOptions.preloadedExtensions} so the work is not
 * repeated. Keep this the single source of the discovery branch logic.
 */
export async function loadSessionExtensions(
	options: DiscoverySessionOptions,
	cwd: string,
	settings: Settings,
	eventBus: EventBus,
): Promise<LoadExtensionsResult> {
	const paths = await discoverSessionExtensionPaths(options, cwd, settings);
	const result = await logger.time("loadExtensions", loadExtensions, paths, cwd, eventBus);
	for (const { path, error } of result.errors) {
		logger.error("Failed to load extension", { path, error });
	}
	return result;
}

/**
 * Load discovered/configured extensions and register their providers into
 * `modelRegistry`, then discover the dynamic provider catalogs. One-shot CLIs
 * (`stp bench`, dry-balance) build a bare {@link ModelRegistry} that only knows
 * built-in catalog providers; without this, providers contributed by an
 * extension (e.g. a custom OpenAI-compatible provider under
 * `~/.stp/agent/extensions/`) never reach model resolution. Mirrors the
 * session / `stp models` path: drain the queued provider registrations, then
 * `refreshRuntimeProviders` so dynamically-discovered models exist before
 * selectors are resolved.
 */
export async function loadCliExtensionProviders(
	modelRegistry: ModelRegistry,
	settings: Settings,
	cwd: string,
	options: DiscoverySessionOptions = {},
): Promise<void> {
	const eventBus = new EventBus();
	const extensionsResult = await loadSessionExtensions(options, cwd, settings, eventBus);
	const activeSources = extensionsResult.extensions.map(extension => extension.path);
	modelRegistry.syncExtensionSources(activeSources);
	for (const sourceId of new Set(activeSources)) {
		modelRegistry.clearSourceRegistrations(sourceId);
	}
	for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config, sourceId);
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	await modelRegistry.refreshRuntimeProviders();
}

/**
 * Discover skills from cwd and agentDir.
 */
export async function discoverSkills(
	cwd?: string,
	_agentDir?: string,
	settings?: SkillsSettings,
): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
	return await loadSkillsInternal({
		...settings,
		cwd: cwd ?? getProjectDir(),
	});
}

/**
 * Discover context files (AGENTS.md) walking up from cwd.
 * Returns files sorted by depth (farther from cwd first, so closer files appear last/more prominent).
 */
export async function discoverContextFiles(
	cwd?: string,
	_agentDir?: string,
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	return await loadContextFilesInternal({
		cwd: cwd ?? getProjectDir(),
	});
}

/**
 * Discover prompt templates from cwd and agentDir.
 */
export async function discoverPromptTemplates(cwd?: string, agentDir?: string): Promise<PromptTemplate[]> {
	return await loadPromptTemplatesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}

/**
 * Discover file-based slash commands from commands/ directories.
 */
export async function discoverSlashCommands(cwd?: string): Promise<FileSlashCommand[]> {
	return loadSlashCommandsInternal({ cwd: cwd ?? getProjectDir() });
}

/**
 * Discover custom commands (TypeScript slash commands) from cwd and agentDir.
 */
export async function discoverCustomTSCommands(cwd?: string, agentDir?: string): Promise<CustomCommandsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	const resolvedAgentDir = agentDir ?? getAgentDir();

	return loadCustomCommandsInternal({
		cwd: resolvedCwd,
		agentDir: resolvedAgentDir,
	});
}

/**
 * Discover MCP servers from .mcp.json files.
 * Returns the manager and loaded tools.
 */
export async function discoverMCPServers(cwd?: string): Promise<MCPToolsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	return discoverAndLoadMCPTools(resolvedCwd);
}
