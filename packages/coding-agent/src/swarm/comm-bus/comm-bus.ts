/**
 * CommBus — Process-global communication bus for the Swarm system.
 *
 * Built on top of IrcBus, provides higher-level routing:
 * - receiveFromHuman: route Human messages through unified bus
 * - groupChannel: named, reusable communication channels for agent groups
 *
 * **Instance injection is preferred** over the {@link global} singleton.
 * Create a fresh CommBus per session:
 *
 * ```ts
 * const bus = new CommBus(ircBus, activityLogger);  // preferred
 * const bus = CommBus.global();                      // backward compat
 * ```
 */

import type { IrcBus } from "../../irc/bus";
import type { HookPipeline } from "../hook-system/hook-pipeline";
import type { HookContext } from "../hook-system/types";
import type { ActivityLogger } from "../infra/activity-logger";
import { CommChannel } from "./comm-channel";

// ============================================================================
// CommBus
// ============================================================================

export class CommBus {
	static #global: CommBus | undefined;

	/**
	 * Get the process-global CommBus singleton.
	 * Lazy-initialized on first call — components should call
	 * {@link ensureGlobal} during startup to wire the IrcBus reference.
	 */
	static global(): CommBus {
		if (!CommBus.#global) {
			CommBus.#global = new CommBus();
		}
		return CommBus.#global;
	}

	/**
	 * Ensure the global singleton is initialized with a specific IrcBus
	 * and ActivityLogger.  Call once during startup.
	 *
	 * If the singleton was already created (via {@link global}), its
	 * IrcBus and ActivityLogger references are updated.
	 */
	static ensureGlobal(ircBus: IrcBus, activityLogger?: ActivityLogger): CommBus {
		if (!CommBus.#global) {
			CommBus.#global = new CommBus(ircBus, activityLogger);
		} else {
			// Update existing singleton that was created via global()
			CommBus.#global.#wire(ircBus, activityLogger);
		}
		return CommBus.#global;
	}

	#ircBus: IrcBus | null = null;
	#activityLogger: ActivityLogger | undefined;
	#hookPipeline: HookPipeline | undefined;
	readonly #channels = new Map<string, CommChannel>();

	constructor(ircBus?: IrcBus, activityLogger?: ActivityLogger, hookPipeline?: HookPipeline) {
		this.#ircBus = ircBus ?? null;
		this.#activityLogger = activityLogger;
		this.#hookPipeline = hookPipeline;
	}

	/** Wire (or re-wire) the IrcBus and ActivityLogger references. */
	#wire(ircBus: IrcBus, activityLogger?: ActivityLogger): void {
		this.#ircBus = ircBus;
		if (activityLogger) this.#activityLogger = activityLogger;
	}

	// -- accessors -------------------------------------------------------

	/** The underlying IrcBus, if wired. */
	get ircBus(): IrcBus | null {
		return this.#ircBus;
	}

	/** Set the HookPipeline reference (post-construction wiring). */
	setHookPipeline(hookPipeline: HookPipeline): void {
		this.#hookPipeline = hookPipeline;
	}

	// -- human interface -------------------------------------------------

	/**
	 * Route a Human message through the unified bus.
	 *
	 * Logs the message via the activity logger (if wired) and optionally
	 * delivers it to a target agent through the IrcBus.
	 *
	 * Replaces the ad-hoc `activityLogger.logBroadcast("human", text)` pattern.
	 */
	async receiveFromHuman(text: string, target?: string): Promise<void> {
		const hookCtx: HookContext = { phase: undefined, agentId: target };

		// Hook: comm:beforeMessage — before sending a message
		await this.#hookPipeline?.trigger("comm:beforeMessage", { from: "human", to: target, message: text }, hookCtx);

		this.#activityLogger?.logBroadcast("human", text);
		if (target && this.#ircBus) {
			// Deliver to target agent via IrcBus (suppressed — human messages
			// are already shown in the UI via the conversation panel).
			await this.#ircBus.send({ from: "human", to: target, body: text }, { suppressRelay: true }).catch(() => {
				// Best-effort: target agent may not exist yet
			});
		}

		// Hook: comm:afterMessage — after the message was sent
		await this.#hookPipeline?.trigger("comm:afterMessage", { from: "human", to: target, message: text }, hookCtx);
	}

	// -- channels --------------------------------------------------------

	/**
	 * Get or create a named communication channel for a group of agents.
	 *
	 * Channels are cached by name — subsequent calls with the same name
	 * return the same CommChannel instance.  This allows multiple components
	 * (StageController, RoleRoundtable, ReporterElection) to share the same
	 * underlying channel.
	 */
	groupChannel(name: string, agentIds: string[], activityLogger?: ActivityLogger): CommChannel {
		let channel = this.#channels.get(name);
		if (!channel) {
			if (!this.#ircBus) {
				throw new Error("CommBus.groupChannel: no IrcBus wired. Call CommBus.ensureGlobal(ircBus) during startup.");
			}
			channel = new CommChannel(this.#ircBus, agentIds, [], activityLogger ?? this.#activityLogger);
			this.#channels.set(name, channel);
		}
		return channel;
	}

	/**
	 * Remove a named channel from the cache.
	 */
	removeChannel(name: string): void {
		this.#channels.delete(name);
	}

	/**
	 * Update the activity logger reference.
	 * Useful when wiring after singleton initialization via {@link global}.
	 */
	setActivityLogger(logger: ActivityLogger): void {
		this.#activityLogger = logger;
	}
}
