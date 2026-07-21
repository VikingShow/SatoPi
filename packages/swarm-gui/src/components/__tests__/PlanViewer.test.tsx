import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders, mockIntersectionObserver } from "./test-utils";

// Mock the swarm store
vi.mock("../../stores/swarm-store", () => ({
  useSwarmStore: vi.fn(() => ({
    swarmState: {
      phase: "idle",
      sessionName: "test-session",
    },
    fetchPlan: vi.fn().mockResolvedValue("# Test Plan\n\nThis is a test plan."),
  })),
}));

// Mock the session store
vi.mock("../../stores/session-store", () => ({
  useSessionStore: vi.fn(() => ({
    currentSession: "test-session",
  })),
}));

// Mock the API client
vi.mock("../../lib/api-client", () => ({
  api: {
    getPlan: vi.fn().mockResolvedValue("# Test Plan\n\nThis is a test plan."),
    savePlan: vi.fn().mockResolvedValue(undefined),
  },
}));

import PlanViewer from "../monitor/PlanViewer";

describe("PlanViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIntersectionObserver();
  });

  it("renders without crashing", () => {
    const { container } = renderWithProviders(<PlanViewer />);
    expect(container).toBeTruthy();
  });

  it("shows plan title or loading state", () => {
    renderWithProviders(<PlanViewer />);
    // Should show either a loading indicator, the plan, or an empty state
    const content = document.body.textContent || "";
    expect(content.length).toBeGreaterThan(0);
  });
});
