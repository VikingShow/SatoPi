// Agent identity, selection, scaling, and role definitions
export { type AgentProfile, type ViolationRecord, type ViolationSeverity, ProfileRegistry } from "./agent-profile";
export { selectAgents, extractDomains, type AgentSelectionInput, type ScoredAgent } from "./agent-selector";
export { computeScaleDelta, type ScaleDeltaParams } from "./agent-scaler";
