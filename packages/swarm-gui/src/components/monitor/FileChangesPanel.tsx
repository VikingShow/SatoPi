/**
 * FileChangesPanel — grouped list of files changed by swarm agents.
 *
 * Data comes from swarm-store.fileChanges populated by SSE file_change events.
 * Files are grouped by path with latest action shown.
 */

import { useSwarmStore } from "../../stores/swarm-store";
import { FileText, Plus, Minus, FilePenLine } from "lucide-react";

const ACTION_ICONS: Record<string, React.ReactNode> = {
  created: <Plus size={11} className="text-success flex-shrink-0" />,
  modified: <FilePenLine size={11} className="text-warning flex-shrink-0" />,
  deleted: <Minus size={11} className="text-danger flex-shrink-0" />,
};

export default function FileChangesPanel() {
  const fileChanges = useSwarmStore((s) => s.fileChanges);

  // Deduplicate by file path — keep latest action
  const fileMap = new Map<string, (typeof fileChanges)[0]>();
  for (const fc of fileChanges) {
    fileMap.set(fc.file, fc);
  }
  const files = Array.from(fileMap.values()).sort((a, b) => b.ts - a.ts);

  if (files.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-fg-faint text-sm">
        <div className="flex flex-col items-center gap-2">
          <FileText size={24} />
          <span>No file changes yet.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2 border-b border-border flex items-center gap-2 bg-background-card">
        <FileText size={14} className="text-fg-muted" />
        <span className="text-xs font-medium text-fg-muted">Files Changed</span>
        <span className="text-xs text-fg-faint tabular-nums">{files.length}</span>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-auto">
        {files.map((fc) => (
          <div
            key={fc.file}
            className="px-4 py-2 border-b border-border/50 flex items-center gap-2 hover:bg-background-elevated/30 transition-colors"
            title={`${fc.action} by ${fc.agent}`}
          >
            {ACTION_ICONS[fc.action] ?? ACTION_ICONS.modified}
            <span className="text-xs font-mono text-foreground flex-1 truncate">
              {fc.file}
            </span>
            <span className="text-[10px] text-fg-faint">{fc.agent}</span>
            {fc.linesChanged !== undefined && (
              <span className="text-[10px] text-fg-faint tabular-nums">
                ±{fc.linesChanged}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
