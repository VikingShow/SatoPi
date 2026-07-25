/**
 * CommEndpoint — typed communication endpoint descriptor.
 *
 * Each participant in a CommChannel has an endpoint that declares its kind
 * (human, agent, system) and the capabilities it supports.  Endpoints are
 * lightweight value objects — they carry no runtime state.
 */

export type EndpointCapability =
  | "send"
  | "receive"
  | "broadcast"
  | "interrupt"
  | "vote"
  | "roundtable";

export interface CommEndpoint {
  readonly id: string;
  readonly kind: "human" | "agent" | "system";
  readonly capabilities: ReadonlySet<EndpointCapability>;
}

const DEFAULT_CAPABILITIES: Record<CommEndpoint["kind"], EndpointCapability[]> = {
  human: ["send", "receive", "broadcast", "interrupt"],
  agent: ["send", "receive", "broadcast", "vote", "roundtable"],
  system: ["send", "broadcast"],
};

/**
 * Create a typed endpoint descriptor.
 * If no capabilities are provided, sensible defaults are applied based on `kind`.
 */
export function createEndpoint(
  id: string,
  kind: CommEndpoint["kind"],
  capabilities?: EndpointCapability[],
): CommEndpoint {
  return {
    id,
    kind,
    capabilities: new Set(capabilities ?? DEFAULT_CAPABILITIES[kind]),
  };
}
