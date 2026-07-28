/**
 * comm-bus — Unified swarm communication layer.
 *
 * Usage:
 *   import { CommBus, CommChannel } from "../comm-bus";
 */

export { CommBus } from "./comm-bus";
export {
	CommChannel,
	type RoundtableOpts,
	type RoundtableResult,
	type VoteOpts,
	type VoteResult,
} from "./comm-channel";
export {
	type RoundtableConfig,
	runRoundtable,
} from "./roundtable";
export { runVote } from "./vote";
