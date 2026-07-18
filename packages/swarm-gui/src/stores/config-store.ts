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

interface WorkersConfig {
  initial: number;
  min: number;
  max: number;
  auto: boolean;
  maxRounds: number;
  roundsConvergenceThreshold: number;
  model: string;
}

interface ClonersConfig {
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
  workers: WorkersConfig;
  cloners: ClonersConfig;
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
  updateWorkers: (patch: Partial<WorkersConfig>) => void;
  updateCloners: (patch: Partial<ClonersConfig>) => void;
  updateConvergence: (patch: Partial<ConvergenceConfig>) => void;
  updateScaling: (patch: Partial<ScalingConfig>) => void;
  updateLoop: (patch: Partial<LoopConfig>) => void;
  setYamlFromForm: () => void;
}

// Defaults match the current loop.yaml so the form opens with the configured
// values if the YAML is unreadable.
const defaultWorkers: WorkersConfig = {
  initial: 3, min: 2, max: 8, auto: true,
  maxRounds: 3, roundsConvergenceThreshold: 2, model: "deepseek-v4-pro",
};

const defaultCloners: ClonersConfig = {
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
    const workers = s.workers ?? {};
    const cloners = s.cloners ?? {};
    return {
      name: typeof s.name === "string" ? s.name : prev.name,
      mode: typeof s.mode === "string" ? s.mode : prev.mode,
      workers: {
        ...prev.workers,
        initial: workers.initial ?? prev.workers.initial,
        min: workers.min ?? prev.workers.min,
        max: workers.max ?? prev.workers.max,
        auto: typeof workers.auto === "boolean" ? workers.auto : prev.workers.auto,
        maxRounds: workers.max_rounds ?? workers.maxRounds ?? prev.workers.maxRounds,
        roundsConvergenceThreshold: workers.rounds_convergence_threshold ?? workers.roundsConvergenceThreshold ?? prev.workers.roundsConvergenceThreshold,
        model: workers.model ?? prev.workers.model,
      },
      cloners: {
        ...prev.cloners,
        count: cloners.count ?? prev.cloners.count,
        model: cloners.model ?? prev.cloners.model,
        reviewStrictness: cloners.review_strictness ?? cloners.reviewStrictness ?? prev.cloners.reviewStrictness,
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
  model: ${config.workers.model}
  max_iterations: ${config.loop.maxIterations}
  auto_retry: true
  human_escalation: ${config.loop.humanEscalation}

  agents: {}

  workers:
    initial: ${config.workers.initial}
    min: ${config.workers.min}
    max: ${config.workers.max}
    auto: ${config.workers.auto}
    max_rounds: ${config.workers.maxRounds}
    rounds_convergence_threshold: ${config.workers.roundsConvergenceThreshold}
    model: ${config.workers.model}

  cloners:
    count: ${config.cloners.count}
    model: ${config.cloners.model}
    review_strictness: ${config.cloners.reviewStrictness}

  convergence_threshold: ${config.convergence.threshold}
  approval_ratio: ${config.convergence.approvalRatio}
  iteration_timeout_ms: ${config.convergence.iterationTimeoutMs}

  scaling:
    super_majority_threshold: ${config.scaling.superMajorityThreshold}
    majority_threshold: ${config.scaling.majorityThreshold}

  agent_restrictions:
    socrates:
      allowed: ["read", "write_file", "grep", "find", "glob"]
`;
}

export const useConfigStore = create<ConfigStore>((set, get) => ({
  name: "SatoPi",
  mode: "loop",
  workers: defaultWorkers,
  cloners: defaultCloners,
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

  updateWorkers: (patch) => {
    set((s) => ({ workers: { ...s.workers, ...patch }, isDirty: true }));
    get().setYamlFromForm();
  },

  updateCloners: (patch) => {
    set((s) => ({ cloners: { ...s.cloners, ...patch }, isDirty: true }));
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
