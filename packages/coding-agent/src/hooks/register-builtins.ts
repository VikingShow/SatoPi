/**
 * register-builtins.ts — Wire all six built-in hooks into a HookPipeline.
 *
 * Call this once during bootstrap (e.g. standalone.ts / SwarmRunManager
 * constructor) to register the full priority chain:
 *
 *   Profile(0) → Stigmergy(1) → Offload(2) → Mnemopi(3) → Experience(4) → Verification(5)
 *
 * All parameters are optional — skip a hook by omitting its dependency.
 * This lets callers that lack a particular service (e.g. no mnemopi) still
 * benefit from the hooks they do have.
 */

import type { ProfileRegistry } from "../agent/agent-profile";
import type { MarkEnvironment } from "../coordination";
import type { ExperienceStore } from "../experience/experience";
import type { IOffloadManager } from "../offload/manager";
import type { SwarmMnemopiAdapter } from "../swarm/infra/mnemopi-adapter";
import { createExperienceHook } from "./builtins/experience-hook";
import { createMnemopiHook } from "./builtins/mnemopi-hook";
import { createOffloadHook } from "./builtins/offload-hook";
import { createProfileHook } from "./builtins/profile-hook";
import { createStigmergyHook } from "./builtins/stigmergy-hook";
import type { VerificationHook } from "./builtins/verification-hook";
import { createVerificationHook } from "./builtins/verification-hook";
import type { HookPipeline } from "./hook-pipeline";
import type { HookRegistration } from "./types";

/** Dependencies for the built-in hook set. All fields are optional. */
export interface BuiltinHookDeps {
	/** Needed by ProfileHook (priority 0). */
	profileRegistry?: ProfileRegistry;
	/** Needed by StigmergyHook (priority 1). */
	markEnvironment?: MarkEnvironment;
	/** Needed by OffloadHook (priority 2). Must satisfy the IOffloadManager interface. */
	offloadManager?: IOffloadManager;
	/** Needed by MnemopiHook (priority 3). */
	mnemopiAdapter?: SwarmMnemopiAdapter;
	/** Needed by ExperienceHook (priority 4). */
	experienceStore?: ExperienceStore;
	/** Needed by VerificationHook (priority 5). */
	verificationHook?: VerificationHook;
}

/**
 * Register a hook only when no hook with the same name AND priority already
 * exists on the pipeline.
 *
 * registerBuiltinHooks is invoked from several bootstrap layers that share one
 * HookPipeline (createOrchestratorRuntime in assembler.ts, the swarm-cli
 * session factory, createSwarmSession, and SessionRegistry.createSession).
 * Without this guard each redundant call re-registers the same builtins and
 * trips the pipeline's "Overwriting existing hook" warning on every startup.
 * First-wins is safe here: the duplicate calls pass the same dependency
 * instances (profileRegistry, experienceStore) or storage-equivalent offload
 * managers bound to the same session directory.
 */
function registerIfAbsent(pipeline: HookPipeline, hook: HookRegistration): boolean {
	const existing = pipeline.list().some(h => h.name === hook.name && h.priority === hook.priority);
	if (existing) return false;
	pipeline.register(hook);
	return true;
}

/**
 * Register all available built-in hooks onto the given pipeline.
 *
 * Idempotent: a hook already registered on the pipeline with the same name and
 * priority is left untouched (see registerIfAbsent), so the multiple bootstrap
 * callsites that share one HookPipeline do not trip the overwrite warning.
 *
 * @param pipeline  The HookPipeline instance to register onto.
 * @param deps      Dependencies for the hooks; omit any you don't have.
 * @returns         Names of the hooks that were successfully registered.
 */
export function registerBuiltinHooks(pipeline: HookPipeline, deps: BuiltinHookDeps): string[] {
	const registered: string[] = [];

	if (deps.profileRegistry) {
		if (registerIfAbsent(pipeline, createProfileHook(deps.profileRegistry))) {
			registered.push("profile-hook");
		}
	}

	if (deps.markEnvironment) {
		if (registerIfAbsent(pipeline, createStigmergyHook(deps.markEnvironment))) {
			registered.push("stigmergy-hook");
		}
	}

	if (deps.offloadManager) {
		if (registerIfAbsent(pipeline, createOffloadHook(deps.offloadManager))) {
			registered.push("offload-hook");
		}
	}

	if (deps.mnemopiAdapter) {
		// Coordination: fan the agent:afterComplete summary into mnemopi,
		// the ExperienceStore and the memories backend from one hook (see
		// createMnemopiHook's coordination deps).
		if (
			registerIfAbsent(pipeline, createMnemopiHook(deps.mnemopiAdapter, { experienceStore: deps.experienceStore }))
		) {
			registered.push("mnemopi-hook");
		}
	}

	if (deps.experienceStore) {
		if (registerIfAbsent(pipeline, createExperienceHook(deps.experienceStore))) {
			registered.push("experience-hook");
		}
	}

	if (deps.verificationHook) {
		if (registerIfAbsent(pipeline, createVerificationHook(deps.verificationHook))) {
			registered.push("verification-hook");
		}
	}

	return registered;
}
