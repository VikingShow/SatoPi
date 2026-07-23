/**
 * Config store — form state for loop.yaml configuration editor.
 *
 * Syncs with backend via REST API. Provides a structured config object
 * that maps to LoopSwarmConfig fields.
 *
 * The form state is the source of truth for the editor. On `loadConfig`,
 * the YAML is parsed and the form fields are populated. On `saveConfig`,
 * the form fields are serialized back into the `swarm:`-wrapped snake_case
 * YAML format that `parseSwarmYaml()` expects.
 */

import { create } from "zustand";
import { api } from "../lib/api-client";
import type { ModelOption } from "../lib/types";

interface AgentsConfig {
  initial: number;
  min: number;
  max: number;
  auto: boolean;
  maxRounds: number;
  roundsConvergenceThreshold: number;
  model: string;
}

interface ReviewersConfig {
  count: number;
  model: string;
  reviewStrictness: string;
}

interface ConvergenceConfig {
  threshold: number;
  approvalRatio: number;
  iterationTimeoutMs: number;
}

interface ScalingConfig {
  superMajorityThreshold: number;
  majorityThreshold: number;
}

interface LoopConfig {
  maxIterations: number;
  humanEscalation: boolean;
}

interface ConfigStore {
  name: string;
  mode: string;
  agents: AgentsConfig;
  reviewers: ReviewersConfig;
  convergence: ConvergenceConfig;
  scaling: ScalingConfig;
  loop: LoopConfig;
  yamlPreview: string;
  isDirty: boolean;
  isLoading: boolean;
  availableModels: ModelOption[];

  loadConfig: () => Promise<void>;
  loadModels: () => Promise<void>;
  saveConfig: () => Promise<void>;
  updateAgents: (patch: Partial<AgentsConfig>) => void;
  updateReviewers: (patch: Partial<ReviewersConfig>) => void;
  updateConvergence: (patch: Partial<ConvergenceConfig>) => void;
  updateScaling: (patch: Partial<ScalingConfig>) => void;
  updateLoop: (patch: Partial<LoopConfig>) => void;
  setYamlFromForm: () => void;
}

// Defaults match the current loop.yaml so the form opens with the configured
// values if the YAML is unreadable.
const defaultAgents: AgentsConfig = {
  initial: 3, min: 2, max: 8, auto: true,
  maxRounds: 3, roundsConvergenceThreshold: 2, model: "deepseek-v4-pro",
};

const defaultReviewers: ReviewersConfig = {
  count: 3, model: "deepseek-v4-pro", reviewStrictness: "strict",
};

const defaultConvergence: ConvergenceConfig = {
  threshold: 0.85, approvalRatio: 0.67, iterationTimeoutMs: 600000,
};

const defaultScaling: ScalingConfig = {
  superMajorityThreshold: 0.67, majorityThreshold: 0.5,
};

const defaultLoop: LoopConfig = {
  maxIterations: 5, humanEscalation: true,
};

// ----------------------------------------------------------------------------
// YAML <-> Form serialization
// ----------------------------------------------------------------------------

/**
 * Parse the swarm YAML (as produced by `parseSwarmYaml()`) and extract the
 * form fields. Falls back to current store values for any missing field so a
 * partial YAML doesn't wipe out the form.
 */
function parseYamlToForm(yaml: string, prev: ConfigStore): Partial<ConfigStore> {
  try {
    const raw = Bun.YAML.parse(yaml) as { swarm?: Record<string, any> } | null;
    if (!raw?.swarm) return {};
    const s = raw.swarm;
    const workers = s.agents ?? {};
    const cloners = s.reviewers ?? {};
    return {
      name: typeof s.name === "string" ? s.name : prev.name,
      mode: typeof s.mode === "string" ? s.mode : prev.mode,
      agents: {
        ...prev.workers,
        initial: workers.initial ?? prev.agents.initial,
        min: workers.min ?? prev.agents.min,
        max: workers.max ?? prev.agents.max,
        auto: typeof workers.auto === "boolean" ? workers.auto : prev.agents.auto,
        maxRounds: workers.max_rounds ?? workers.maxRounds ?? prev.agents.maxRounds,
        roundsConvergenceThreshold: workers.rounds_convergence_threshold ?? workers.roundsConvergenceThreshold ?? prev.agents.roundsConvergenceThreshold,
        model: workers.model ?? prev.agents.model,
      },
      reviewers: {
        ...prev.cloners,
        count: cloners.count ?? prev.agents.reviewerscount,
        model: cloners.model ?? prev.agents.reviewersmodel,
        reviewStrictness: cloners.review_strictness ?? cloners.reviewStrictness ?? prev.agents.reviewersreviewStrictness,
      },
      loop: {
        maxIterations: s.max_iterations ?? s.maxIterations ?? prev.loop.maxIterations,
        humanEscalation: typeof s.human_escalation === "boolean"
          ? s.human_escalation
          : (typeof s.humanEscalation === "boolean" ? s.humanEscalation : prev.loop.humanEscalation),
      },
      convergence: {
        threshold: s.convergence_threshold ?? s.convergenceThreshold ?? prev.convergence.threshold,
        approvalRatio: s.approval_ratio ?? s.approvalRatio ?? prev.convergence.approvalRatio,
        iterationTimeoutMs: s.iteration_timeout_ms ?? s.iterationTimeoutMs ?? prev.convergence.iterationTimeoutMs,
      },
      scaling: {
        superMajorityThreshold: s.scaling?.super_majority_threshold ?? s.scaling?.superMajorityThreshold ?? prev.scaling.superMajorityThreshold,
        majorityThreshold: s.scaling?.majority_threshold ?? s.scaling?.majorityThreshold ?? prev.scaling.majorityThreshold,
      },
    };
  } catch {
    return {};
  }
}

/**
 * Build the canonical `swarm:`-wrapped snake_case YAML that the backend
 * `parseSwarmYaml()` expects. This is the inverse of `parseYamlToForm`.
 */
function buildYaml(config: ConfigStore): string {
  return `swarm:
  name: ${config.name}
  workspace: .
  mode: ${config.mode}
  target_count: 1
  model: ${config.agents.model}
  max_iterations: ${config.loop.maxIterations}
  auto_retry: true
  human_escalation: ${config.loop.humanEscalation}

  agents: {}

  agents:
    initial: ${config.agents.initial}
    min: ${config.agents.min}
    max: ${config.agents.max}
    auto: ${config.agents.auto}
    max_rounds: ${config.agents.maxRounds}
    rounds_convergence_threshold: ${config.agents.roundsConvergenceThreshold}
    model: ${config.agents.model}

  reviewers:
    count: ${config.agents.reviewerscount}
    model: ${config.agents.reviewersmodel}
    review_strictness: ${config.agents.reviewersreviewStrictness}

  convergence_threshold: ${config.convergence.threshold}
  approval_ratio: ${config.convergence.approvalRatio}
  iteration_timeout_ms: ${config.convergence.iterationTimeoutMs}

  scaling:
    super_majority_threshold: ${config.scaling.superMajorityThreshold}
    majority_threshold: ${config.scaling.majorityThreshold}

  agent_restrictions:
    planner:
      allowed: ["read", "write_file", "grep", "find", "glob"]
`;
}

export const useConfigStore = create<ConfigStore>((set, get) => ({
  name: "SatoPi",
  mode: "loop",
  agents: defaultAgents,
  reviewers: defaultReviewers,
  convergence: defaultConvergence,
  scaling: defaultScaling,
  loop: defaultLoop,
  yamlPreview: "",
  isDirty: false,
  isLoading: false,
  availableModels: [],

  loadConfig: async () => {
    set({ isLoading: true });
    try {
      const { yaml } = await api.getConfig();
      // Parse YAML → form fields, AND keep yamlPreview in sync
      const patch = parseYamlToForm(yaml, get());
      set({ ...patch, yamlPreview: yaml, isLoading: false, isDirty: false });
    } catch {
      // Fallback: serialize current form to YAML (so the preview is never empty)
      get().setYamlFromForm();
      set({ isLoading: false });
    }
  },

  loadModels: async () => {
    try {
      const { models } = await api.getModels();
      set({ availableModels: models ?? [] });
    } catch {
      // leave availableModels empty on failure
    }
  },

  saveConfig: async () => {
    get().setYamlFromForm();
    const yaml = get().yamlPreview;
    await api.saveConfig(yaml);
    set({ isDirty: false });
  },

  updateAgents: (patch) => {
    set((s) => ({ agents: { ...s.agents, ...patch }, isDirty: true }));
    get().setYamlFromForm();
  },

  updateReviewers: (patch) => {
    set((s) => ({ reviewers: { ...s.reviewers, ...patch }, isDirty: true }));
    get().setYamlFromForm();
  },

  updateConvergence: (patch) => {
    set((s) => ({ convergence: { ...s.convergence, ...patch }, isDirty: true }));
    get().setYamlFromForm();
  },

  updateScaling: (patch) => {
    set((s) => ({ scaling: { ...s.scaling, ...patch }, isDirty: true }));
    get().setYamlFromForm();
  },

  updateLoop: (patch) => {
    set((s) => ({ loop: { ...s.loop, ...patch }, isDirty: true }));
    get().setYamlFromForm();
  },

  setYamlFromForm: () => {
    set((s) => ({ yamlPreview: buildYaml(s) }));
  },
}));
