import type { ReactNode } from "react";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}

/**
 * EmptyState — consistent placeholder for pages with no content.
 *
 * Use design tokens: icon in fg-faint, title in fg-muted, desc in fg-faint.
 */
export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center gap-3 px-6 py-12">
      {icon && <div className="text-fg-faint">{icon}</div>}
      <div className="space-y-1">
        <p className="text-sm font-medium text-fg-muted">{title}</p>
        {description && <p className="text-xs text-fg-faint max-w-sm">{description}</p>}
      </div>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
