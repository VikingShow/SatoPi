// Infrastructure services — NOT hooks. These are shared utilities consumed
// across the entire swarm subsystem.
//
// - ActivityLogger: event logging/broadcast service used by every component
// - MnemopiAdapter: adapter for the Mnemopi memory system
//
// For the actual hook pipeline system (HookPipeline, built-in hooks), see
// ../hook-system/

export {
	type ActivityBroadcaster,
	type ActivityEntry,
	type ActivityEventType,
	ActivityLogger,
} from "../../infra/activity-logger";
export {
	type MnemopiAdapterConfig,
	type MnemopiClient,
	type MnemopiRecallItem,
	type RecallResult,
	SwarmMnemopiAdapter,
} from "./mnemopi-adapter";
