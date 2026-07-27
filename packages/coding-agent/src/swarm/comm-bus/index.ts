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
	type CommEndpoint,
	createEndpoint,
	type EndpointCapability,
} from "./endpoint";
export {
	jaccardSimilarity,
	type RoundtableConfig,
	runRoundtable,
	tokenize,
} from "./roundtable";
export { parseVote, runVote } from "./vote";
