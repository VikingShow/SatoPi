import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./test-utils";
import { ErrorBoundary } from "../shared/ErrorBoundary";

function ThrowOnRender({ error }: { error?: Error }) {
  if (error) throw error;
  return <div>Content OK</div>;
}

describe("ErrorBoundary (shared)", () => {
  it("renders children when no error", () => {
    renderWithProviders(
      <ErrorBoundary>
        <ThrowOnRender />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Content OK")).toBeInTheDocument();
  });

  it("renders fallback when child throws", () => {
    // Suppress console.error from React's error boundary logging
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    renderWithProviders(
      <ErrorBoundary>
        <ThrowOnRender error={new Error("Test crash")} />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/⚠ Failed to render this message/)).toBeInTheDocument();
    spy.mockRestore();
  });

  it("renders custom fallback when provided", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    renderWithProviders(
      <ErrorBoundary fallback={<div>Custom fallback</div>}>
        <ThrowOnRender error={new Error("Crash")} />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Custom fallback")).toBeInTheDocument();
    spy.mockRestore();
  });
});
