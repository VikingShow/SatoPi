// Lifecycle hooks, activity logging, and mnemopi adapter
export { createStageFeedback, type SwarmHooksConfig } from "./swarm-hooks";
export { ActivityLogger, type ActivityBroadcaster, type ActivityEntry, type ActivityEventType } from "./activity-logger";
export { SwarmMnemopiAdapter, type MnemopiAdapterConfig, type RecallResult, type MnemopiClient, type MnemopiRecallItem } from "./mnemopi-adapter";
