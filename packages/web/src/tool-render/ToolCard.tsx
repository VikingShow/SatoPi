/**
 * ToolCard — expandable/collapsible card for swarm tool-call visualization.
 *
 * Header shows tool name, file path, and duration badge.
 * Body dispatches to DiffBlock (edit/write_file), Output (bash),
 * or CodeBlock (grep/read/other) based on tool type.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Wrench, Clock } from "lucide-react";
import { Badge, PathText, CodeBlock, Output, DiffBlock } from "./parts";
import { languageFromPath } from "./util";

export interface ToolCardProps {
  tool: string;
  file?: string;
  summary: string;
  detail?: string;
  duration?: number;
  exitCode?: number;
  collapsed?: boolean;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function ToolCard({
  tool,
  file,
  summary,
  detail,
  duration,
  exitCode,
  collapsed = true,
}: ToolCardProps) {
  const [open, setOpen] = useState(!collapsed);

  const icon = open ? (
    <ChevronDown size={14} className="text-fg-muted flex-shrink-0" />
  ) : (
    <ChevronRight size={14} className="text-fg-muted flex-shrink-0" />
  );

  const detailView = detail ? renderDetail(tool, file, detail) : null;
  const hasDetail = detailView != null;

  return (
    <div className="tv-card my-1 rounded-lg border border-border overflow-hidden">
      {/* Header */}
      <button
        type="button"
        className="tv-head w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-background-elevated/30 transition-colors cursor-pointer"
        onClick={() => hasDetail && setOpen((v) => !v)}
        disabled={!hasDetail}
      >
        {hasDetail ? icon : <Wrench size={14} className="text-fg-muted flex-shrink-0" />}
        <Badge tone={toolTone(tool)}>{tool}</Badge>
        {file && <PathText path={file} />}
        <span className="text-xs text-fg-muted truncate flex-1">{summary.slice(0, 80)}</span>
        {duration !== undefined && (
          <span className="flex items-center gap-0.5 text-[10px] text-fg-faint flex-shrink-0">
            <Clock size={10} />
            {formatMs(duration)}
          </span>
        )}
        {exitCode !== undefined && exitCode !== 0 && (
          <Badge tone="err">exit {exitCode}</Badge>
        )}
      </button>

      {/* Body */}
      {open && detailView && <div className="tv-body px-2.5 pb-2">{detailView}</div>}
    </div>
  );
}

function toolTone(tool: string): "ok" | "err" | "warn" | "accent" | undefined {
  const t = tool.toLowerCase();
  if (t === "write_file" || t === "edit") return "ok";
  if (t === "bash" || t === "shell") return "accent";
  if (t === "grep" || t === "glob" || t === "read") return undefined;
  return undefined;
}

function renderDetail(tool: string, file: string | undefined, detail: string): React.ReactNode {
  const t = tool.toLowerCase();
  const lang = file ? languageFromPath(file) : null;

  if (t === "edit" || t === "write_file") {
    if (detail.includes("@@") || (detail.includes("+") && detail.includes("-"))) {
      return <DiffBlock diff={detail} maxLines={40} />;
    }
    return <CodeBlock code={detail} lang={lang} maxLines={20} />;
  }

  if (t === "bash" || t === "shell") {
    return <Output text={detail} maxLines={12} />;
  }

  if (t === "read" || t === "grep" || t === "glob") {
    return <Output text={detail} maxLines={15} lang={lang ?? undefined} />;
  }

  // Default: code block
  return <CodeBlock code={detail} lang={lang} maxLines={15} />;
}
