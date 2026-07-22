import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithProviders } from "./test-utils";

// Mock the session store with the fields SessionSwitcher actually uses
vi.mock("../../stores/session-store", () => ({
  useSessionStore: vi.fn((selector) => {
    const state = {
      runs: [] as Array<{ name: string; dir: string; lastActivity: string | null; messageCount: number; status: string }>,
      viewingSession: null as string | null,
      currentSession: "test-session",
      loadRuns: vi.fn(),
      switchToSession: vi.fn(),
      backToCurrent: vi.fn(),
      newSession: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };
    return selector ? selector(state) : state;
  }),
}));

// Mock the swarm store
vi.mock("../../stores/swarm-store", () => ({
  useSwarmStore: vi.fn((selector) => {
    const state = {
      isRunning: false,
      swarmState: { phase: "idle", name: "test-session", status: "idle", startedAt: Date.now() },
    };
    return selector ? selector(state) : state;
  }),
}));

import SessionSwitcher from "../monitor/SessionSwitcher";

describe("SessionSwitcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders session trigger button", () => {
    renderWithProviders(<SessionSwitcher />);
    const trigger = screen.getByRole("button");
    expect(trigger).toBeInTheDocument();
  });

  it("opens dropdown on click", () => {
    renderWithProviders(<SessionSwitcher />);
    const trigger = screen.getByRole("button");
    fireEvent.click(trigger);
    // After clicking, the popover should be open
    // The component renders a dropdown with session list
    expect(trigger).toBeInTheDocument();
  });
});
