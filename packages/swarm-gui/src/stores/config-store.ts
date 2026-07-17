/**
 * Config store — form state for loop.yaml configuration editor.
 *
 * Syncs with backend via REST API. Provides a structured config object
 * that maps to LoopSwarmConfig fields.
 */

import { create } from "zustand";
import { api } from "../lib/api-client";

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

  loadConfig: () => Promise<void>;
  saveConfig: () => Promise<void>;
  updateWorkers: (patch: Partial<WorkersConfig>) => void;
  updateCloners: (patch: Partial<ClonersConfig>) => void;
  updateConvergence: (patch: Partial<ConvergenceConfig>) => void;
  updateScaling: (patch: Partial<ScalingConfig>) => void;
  updateLoop: (patch: Partial<LoopConfig>) => void;
  setYamlFromForm: () => void;
}

const defaultWorkers: WorkersConfig = {
  initial: 3, min: 2, max: 8, auto: true,
  maxRounds: 3, roundsConvergenceThreshold: 2, model: "deepseek-chat",
};

const defaultCloners: ClonersConfig = {
  count: 3, model: "gpt-4o", reviewStrictness: "strict",
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

function buildYaml(config: ConfigStore): string {
  return `name: ${config.name}
mode: ${config.mode}
workers:
  initial: ${config.workers.initial}
  min: ${config.workers.min}
  max: ${config.workers.max}
  auto: ${config.workers.auto}
  maxRounds: ${config.workers.maxRounds}
  roundsConvergenceThreshold: ${config.workers.roundsConvergenceThreshold}
  model: ${config.workers.model}
cloners:
  count: ${config.cloners.count}
  model: ${config.cloners.model}
  reviewStrictness: ${config.cloners.reviewStrictness}
convergenceThreshold: ${config.convergence.threshold}
approvalRatio: ${config.convergence.approvalRatio}
iterationTimeoutMs: ${config.convergence.iterationTimeoutMs}
scaling:
  superMajorityThreshold: ${config.scaling.superMajorityThreshold}
  majorityThreshold: ${config.scaling.majorityThreshold}
maxIterations: ${config.loop.maxIterations}
humanEscalation: ${config.loop.humanEscalation}
`;
}

export const useConfigStore = create<ConfigStore>((set, get) => ({
  name: "swarm-run",
  mode: "loop",
  workers: defaultWorkers,
  cloners: defaultCloners,
  convergence: defaultConvergence,
  scaling: defaultScaling,
  loop: defaultLoop,
  yamlPreview: "",
  isDirty: false,
  isLoading: false,

  loadConfig: async () => {
    set({ isLoading: true });
    try {
      const { yaml } = await api.getConfig();
      set({ yamlPreview: yaml, isLoading: false, isDirty: false });
    } catch {
      get().setYamlFromForm();
      set({ isLoading: false });
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
