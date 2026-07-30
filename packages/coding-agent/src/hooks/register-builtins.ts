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
import type { VerificationHook } from "../swarm/core/verification-hook";
import type { SwarmMnemopiAdapter } from "../swarm/infra/mnemopi-adapter";
import { createExperienceHook } from "./builtins/experience-hook";
import { createMnemopiHook } from "./builtins/mnemopi-hook";
import { createOffloadHook } from "./builtins/offload-hook";
import { createProfileHook } from "./builtins/profile-hook";
import { createStigmergyHook } from "./builtins/stigmergy-hook";
import { createVerificationHook } from "./builtins/verification-hook";
import type { HookPipeline } from "./hook-pipeline";

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
 * Register all available built-in hooks onto the given pipeline.
 *
 * @param pipeline  The HookPipeline instance to register onto.
 * @param deps      Dependencies for the hooks; omit any you don't have.
 * @returns         Names of the hooks that were successfully registered.
 */
export function registerBuiltinHooks(pipeline: HookPipeline, deps: BuiltinHookDeps): string[] {
	const registered: string[] = [];

	if (deps.profileRegistry) {
		pipeline.register(createProfileHook(deps.profileRegistry));
		registered.push("profile-hook");
	}

	if (deps.markEnvironment) {
		pipeline.register(createStigmergyHook(deps.markEnvironment));
		registered.push("stigmergy-hook");
	}

	if (deps.offloadManager) {
		pipeline.register(createOffloadHook(deps.offloadManager));
		registered.push("offload-hook");
	}

	if (deps.mnemopiAdapter) {
		pipeline.register(createMnemopiHook(deps.mnemopiAdapter));
		registered.push("mnemopi-hook");
	}

	if (deps.experienceStore) {
		pipeline.register(createExperienceHook(deps.experienceStore));
		registered.push("experience-hook");
	}

	if (deps.verificationHook) {
		pipeline.register(createVerificationHook(deps.verificationHook));
		registered.push("verification-hook");
	}

	return registered;
}
