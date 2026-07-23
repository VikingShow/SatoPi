/**
 * config-store.test.ts — Tests for Zustand config store.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/api-client", () => ({
  api: {
    getConfig: vi.fn(),
    saveConfig: vi.fn(),
    getState: vi.fn(),
  },
}));

import { api } from "../../lib/api-client";
import { useConfigStore } from "../config-store";

function getStore() {
  return useConfigStore.getState();
}

beforeEach(() => {
  useConfigStore.setState({
    name: "swarm-run",
    mode: "loop",
    workers: { initial: 3, min: 2, max: 8, auto: true, maxRounds: 3, roundsConvergenceThreshold: 2, model: "deepseek-chat" },
    cloners: { count: 3, model: "gpt-4o", reviewStrictness: "strict" },
    convergence: { threshold: 0.85, approvalRatio: 0.67, iterationTimeoutMs: 600000 },
    scaling: { superMajorityThreshold: 0.67, majorityThreshold: 0.5 },
    loop: { maxIterations: 5, humanEscalation: true },
    yamlPreview: "",
    isDirty: false,
    isLoading: false,
  });
  vi.clearAllMocks();
});

describe("ConfigStore: initial state", () => {
  it("default mode is loop", () => {
    expect(getStore().mode).toBe("loop");
  });

  it("default workers count is 3", () => {
    expect(getStore().agents.initial).toBe(3);
  });

  it("starts not dirty", () => {
    expect(getStore().isDirty).toBe(false);
  });
});

describe("ConfigStore: update actions", () => {
  it("updateWorkers updates values and marks dirty", () => {
    getStore().updateWorkers({ initial: 8 });
    expect(getStore().agents.initial).toBe(8);
    expect(getStore().isDirty).toBe(true);
  });

  it("updateReviewers updates count", () => {
    getStore().updateReviewers({ count: 5, reviewStrictness: "lenient" });
    expect(getStore().agents.reviewerscount).toBe(5);
    expect(getStore().agents.reviewersreviewStrictness).toBe("lenient");
  });

  it("updateLoop toggles human escalation", () => {
    getStore().updateLoop({ humanEscalation: false });
    expect(getStore().loop.humanEscalation).toBe(false);
  });
});

describe("ConfigStore: load/save cycle", () => {
  it("loadConfig fetches yaml and stores as preview", async () => {
    const yaml = "name: test-swarm\nmode: loop\nworkers:\n  initial: 5";
    (api.getConfig as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ yaml });
    await getStore().loadConfig();
    expect(getStore().yamlPreview).toBe(yaml);
    expect(getStore().isDirty).toBe(false);
  });

  it("setYamlFromForm generates yaml from form state", () => {
    getStore().updateWorkers({ initial: 10 });
    getStore().setYamlFromForm();
    expect(getStore().yamlPreview).toContain("initial: 10");
  });
});
