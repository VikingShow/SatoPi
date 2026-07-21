import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./test-utils";
import { EmptyState } from "../shared/EmptyState";
import { FileText } from "lucide-react";

describe("EmptyState", () => {
  it("renders title and description", () => {
    renderWithProviders(
      <EmptyState
        icon={<FileText size={24} />}
        title="No messages yet"
        description="Start a conversation to begin"
      />,
    );

    expect(screen.getByText("No messages yet")).toBeInTheDocument();
    expect(screen.getByText("Start a conversation to begin")).toBeInTheDocument();
  });

  it("renders without description", () => {
    renderWithProviders(
      <EmptyState title="No data" />,
    );

    expect(screen.getByText("No data")).toBeInTheDocument();
  });

  it("renders action when provided", () => {
    renderWithProviders(
      <EmptyState
        title="No sessions"
        action={<button>Create session</button>}
      />,
    );

    expect(screen.getByText("Create session")).toBeInTheDocument();
  });

  it("does not render icon when not provided", () => {
    const { container } = renderWithProviders(
      <EmptyState title="Empty" />,
    );

    // Only the title paragraph should be present, no icon wrapper
    expect(container.querySelectorAll("svg")).toHaveLength(0);
  });
});
