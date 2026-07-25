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
  runRoundtable,
  jaccardSimilarity,
  tokenize,
  type RoundtableConfig,
} from "./roundtable";
export { runVote, parseVote } from "./vote";
export {
  createEndpoint,
  type CommEndpoint,
  type EndpointCapability,
} from "./endpoint";
