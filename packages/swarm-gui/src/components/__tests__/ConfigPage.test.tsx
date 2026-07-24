import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./test-utils";

// Mock the config store with all fields ConfigPage destructures
vi.mock("../../stores/config-store", () => ({
  useConfigStore: vi.fn(() => ({
    agents: { initial: 3, min: 2, max: 8, auto: true, maxRounds: 3, roundsConvergenceThreshold: 2, model: "gpt-4" },
    convergence: { threshold: 0.85, approvalRatio: 0.67, iterationTimeoutMs: 600000 },
    scaling: { superMajorityThreshold: 0.67, majorityThreshold: 0.5 },
    loop: { maxIterations: 10, humanEscalation: true },
    yamlPreview: "swarm:\n  name: test-swarm\n  agents:\n    initial: 3",
    isDirty: false,
    isLoading: false,
    availableModels: [{ id: "gpt-4" }, { id: "claude-3" }],
    loadConfig: vi.fn(),
    loadModels: vi.fn(),
    saveConfig: vi.fn(),
    updateAgents: vi.fn(),
    updateConvergence: vi.fn(),
    updateScaling: vi.fn(),
    updateLoop: vi.fn(),
  })),
}));

// Mock the swarm store
vi.mock("../../stores/swarm-store", () => ({
  useSwarmStore: vi.fn((selector) => {
    const state = { isRunning: false, stopRun: vi.fn(), swarmState: { phase: "idle" } };
    return selector ? selector(state) : state;
  }),
}));

import ConfigPage from "../config/ConfigPage";

describe("ConfigPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders without crashing", () => {
    const { container } = renderWithProviders(<ConfigPage />);
    expect(container).toBeTruthy();
  });

  it("renders number inputs for agent count configuration", () => {
    renderWithProviders(<ConfigPage />);
    const inputs = document.querySelectorAll('input[type="number"]');
    expect(inputs.length).toBeGreaterThan(0);
  });

  it("renders select elements for model selection", () => {
    renderWithProviders(<ConfigPage />);
    const selects = document.querySelectorAll("select");
    expect(selects.length).toBeGreaterThan(0);
  });

  it("renders save button", () => {
    renderWithProviders(<ConfigPage />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
  });
});
