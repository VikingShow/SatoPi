import { Component } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "./ui/button";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary] Caught:", error, info);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex items-center justify-center h-screen bg-background">
          <div className="flex flex-col items-center gap-4 p-8 max-w-md text-center">
            <div className="w-12 h-12 rounded-full bg-status-danger/10 flex items-center justify-center">
              <AlertTriangle size={24} className="text-status-danger" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-foreground mb-1">Something went wrong</h2>
              <p className="text-sm text-muted-foreground break-all">
                {this.state.error?.message ?? "An unexpected error occurred."}
              </p>
            </div>
            <Button onClick={this.handleRetry}>
              <RefreshCw size={14} />
              Retry
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
