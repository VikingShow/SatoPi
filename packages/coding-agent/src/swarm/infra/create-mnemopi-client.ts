/**
 * createSwarmMnemopiClient — Factory for swarm Mnemopi access.
 *
 * Creates a standalone Mnemopi instance for the swarm session using
 * the same Settings/MnemopiConfig as the main coding-agent. The swarm
 * uses its own workspace-scoped bank so semantic memory recall works
 * without sharing state with an interactive TUI session.
 *
 * Gracefully degrades: returns null when Mnemopi is not configured
 * or the @oh-my-pi/pi-mnemopi package is unavailable.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import type { MnemopiClient } from "./mnemopi-adapter";

/**
 * Create a MnemopiClient for a swarm session.
 *
 * Lazily loads @oh-my-pi/pi-mnemopi to keep it off the module graph
 * for sessions that never touch the memory backend.
 *
 * @param settings  Agent settings (from which MnemopiConfig is read).
 * @param workspace   Agent directory (used as fallback when settings have no dbPath).
 * @returns MnemopiClient or null if Mnemopi is unavailable.
 */
export async function createSwarmMnemopiClient(settings: Settings, workspace: string): Promise<MnemopiClient | null> {
	try {
		const [{ loadMnemopiConfig }, { loadMnemopi, loadMnemopiCore }] = await Promise.all([
			import("../../mnemopi/config"),
			import("../../mnemopi/state"),
		]);

		const config = loadMnemopiConfig(settings, workspace);
		if (!config) return null;

		const [{ Mnemopi }] = await Promise.all([loadMnemopi(), loadMnemopiCore()]);

		const mnemopi = new Mnemopi({
			dbPath: config.dbPath,
			bank: config.bank,
			sessionId: "swarm",
			authorId: "swarm",
			authorType: "agent",
			channelId: "swarm",
			noEmbeddings: config.providerOptions.noEmbeddings ?? true,
			reconcile: false,
		} as ConstructorParameters<typeof Mnemopi>[0]);

		return {
			async recall(query: string, topK: number = 5) {
				try {
					const results = mnemopi.recallSync(query, { limit: topK });
					return results.map(r => ({
						content: r.content,
						source: r.source ?? null,
						score: r.score,
						sessionId: "swarm",
						timestamp: r.timestamp ?? null,
					}));
				} catch {
					return [];
				}
			},
			async remember(content: string, metadata?: Record<string, unknown>) {
				try {
					mnemopi.remember(content, { ...metadata, source: "swarm" });
				} catch {
					// Best-effort store
				}
			},
		};
	} catch (err) {
		logger.debug("[createSwarmMnemopiClient] Mnemopi unavailable, degrading", {
			error: String(err),
		});
		return null;
	}
}
