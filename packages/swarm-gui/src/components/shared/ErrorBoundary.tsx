import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Generic React error boundary.
 *
 * Used to isolate rendering failures (e.g. a malformed Markdown message or a
 * plugin throwing on odd input) so a single bad item cannot take down the whole
 * chat list. When it catches, it renders a compact fallback instead of a blank
 * screen, and optionally shows the raw text so no content is lost.
 */
interface Props {
  children: ReactNode;
  /** Optional raw text to reveal when rendering fails (e.g. the message body). */
  fallbackText?: string;
  /** Optional custom fallback node. Overrides the default. */
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep it quiet in the UI but observable in the console for debugging.
    console.error("[ErrorBoundary] render failure:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    return (
      <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words border border-border rounded px-2 py-1 bg-background/40">
        <span className="text-amber-500/80">⚠ Failed to render this message.</span>
        {this.props.fallbackText ? `\n${this.props.fallbackText}` : ""}
      </div>
    );
  }
}
