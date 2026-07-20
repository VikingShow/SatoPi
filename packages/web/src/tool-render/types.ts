/**
 * Tool renderer contract — shared types for SatoPi tool-call visualization.
 *
 * Extracted and simplified from collab-web tool-render.
 * Every tool gets a renderer with two React components:
 * - Summary — one-line inline header content
 * - Body — expanded detail view
 */

export interface ToolResultText {
  type: "text";
  text: string;
}

export type ToolResultBlock = ToolResultText | { type: string };

export interface ToolResultLike {
  content: readonly ToolResultBlock[];
  details?: unknown;
  isError?: boolean;
}

export interface ToolRenderHost {
  hasAgent?(id: string): boolean;
  openAgent?(id: string): void;
}

export interface ToolRenderProps {
  name: string;
  args: Record<string, unknown>;
  result?: ToolResultLike;
  running?: boolean;
  host?: ToolRenderHost;
}

export interface ToolRenderer {
  Summary: React.ComponentType<ToolRenderProps>;
  Body?: React.ComponentType<ToolRenderProps>;
}
