import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "./test-utils";
import { Button } from "../ui/button";
import { Send } from "lucide-react";

describe("Button", () => {
  it("renders with default variant", () => {
    renderWithProviders(<Button>Click me</Button>);
    const btn = screen.getByRole("button", { name: "Click me" });
    expect(btn).toBeInTheDocument();
  });

  it("renders with ghost variant", () => {
    renderWithProviders(<Button variant="ghost">Ghost</Button>);
    expect(screen.getByRole("button", { name: "Ghost" })).toBeInTheDocument();
  });

  it("renders with destructive variant", () => {
    renderWithProviders(<Button variant="destructive">Delete</Button>);
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("renders with icon", () => {
    renderWithProviders(
      <Button variant="ghost" size="icon-sm">
        <Send size={14} />
      </Button>,
    );
    const btn = screen.getByRole("button");
    expect(btn).toBeInTheDocument();
    expect(btn.querySelector("svg")).toBeTruthy();
  });

  it("is disabled when disabled prop is set", () => {
    renderWithProviders(<Button disabled>Disabled</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("calls onClick when clicked", async () => {
    const onClick = vi.fn();
    renderWithProviders(<Button onClick={onClick}>Click</Button>);
    const btn = screen.getByRole("button", { name: "Click" });
    btn.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders with xs size", () => {
    renderWithProviders(<Button size="xs">Small</Button>);
    expect(screen.getByRole("button", { name: "Small" })).toBeInTheDocument();
  });

  it("renders with sm size", () => {
    renderWithProviders(<Button size="sm">Small</Button>);
    expect(screen.getByRole("button", { name: "Small" })).toBeInTheDocument();
  });

  it("accepts custom className", () => {
    renderWithProviders(
      <Button className="custom-class">Custom</Button>,
    );
    const btn = screen.getByRole("button", { name: "Custom" });
    expect(btn.className).toContain("custom-class");
  });

  it("renders link variant", () => {
    renderWithProviders(<Button variant="link">Link</Button>);
    expect(screen.getByRole("button", { name: "Link" })).toBeInTheDocument();
  });
});
