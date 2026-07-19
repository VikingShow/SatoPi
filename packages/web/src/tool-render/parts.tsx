/**
 * Shared UI primitives for tool renderers.
 * Extracted and simplified from collab-web tool-render.
 * CodeBlock uses Shiki (via @oh-my-pi/pi-web/shiki) instead of hljs.
 */

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { highlightCode } from "@oh-my-pi/pi-web/shiki";
import { shortenPath, stripAnsi } from "./util";

// ── Badge ──────────────────────────────────────────────────────────

export type Tone = "accent" | "ok" | "err" | "warn";

export function Badge({ children, tone }: { children: ReactNode; tone?: Tone }): ReactNode {
  if (children == null || children === "" || children === false) return null;
  return <span className={`tv-badge${tone ? ` tv-badge--${tone}` : ""}`}>{children}</span>;
}

export function Badges({ items }: { items: ReadonlyArray<ReactNode> }): ReactNode {
  const visible = items.filter((item) => item != null && item !== "" && item !== false);
  if (visible.length === 0) return null;
  return (
    <span className="tv-badges">
      {visible.map((item, i) => (
        <Badge key={i}>{item}</Badge>
      ))}
    </span>
  );
}

// ── PathText ──────────────────────────────────────────────────────

export function PathText({
  path,
  from,
  to,
}: {
  path: string;
  from?: number | null;
  to?: number | null;
}): ReactNode {
  let range = "";
  if (from != null || to != null) {
    const start = from ?? 1;
    range = to != null ? `:${start}-${to}` : `:${start}`;
  }
  return (
    <span className="tv-path">
      {shortenPath(path)}
      {range && <span className="tv-lines">{range}</span>}
    </span>
  );
}

// ── CodeBlock (Shiki-based) ──────────────────────────────────────

const CODE_CACHE = new Map<string, string>();

export function CodeBlock({
  code,
  lang,
  maxLines = 20,
}: {
  code: string;
  lang: string | null;
  maxLines?: number;
}): ReactNode {
  const [html, setHtml] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const lines = code.split("\n");
  const collapsible = lines.length > maxLines;
  const displayCode = collapsible && !expanded ? lines.slice(0, maxLines).join("\n") : code;

  const resolvedLang = lang ?? "text";
  const cacheKey = `${resolvedLang}:${code.slice(0, 300)}`;

  useEffect(() => {
    let cancelled = false;
    if (CODE_CACHE.has(cacheKey)) {
      setHtml(CODE_CACHE.get(cacheKey)!);
      return;
    }
    highlightCode(displayCode, resolvedLang).then((h) => {
      if (!cancelled) {
        CODE_CACHE.set(cacheKey, h);
        setHtml(h);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, displayCode, resolvedLang]);

  return (
    <div className="tv-out">
      {html ? (
        <div className="[&_pre]:bg-[#0d0d0d]! [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:text-xs [&_pre]:rounded-lg" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="tv-code">
          <code>{displayCode}</code>
        </pre>
      )}
      {collapsible && (
        <button type="button" className="tv-expand" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "collapse" : `… ${lines.length - maxLines} more lines`}
        </button>
      )}
    </div>
  );
}

// ── Output ──────────────────────────────────────────────────────

export function Output({
  text,
  maxLines = 10,
  lang,
  error,
  title,
}: {
  text: string;
  maxLines?: number;
  lang?: string;
  error?: boolean;
  title?: string;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const clean = stripAnsi(text);
  const lines = clean.split("\n");
  const collapsible = lines.length > maxLines;
  const shown = collapsible && !expanded ? lines.slice(0, maxLines) : lines;

  return (
    <div className={`tv-out${error ? " tv-out--err" : ""}`}>
      <pre className={`tv-code${lang ? ` language-${lang}` : ""}`}>
        {title && <span className="tv-out-title">{title}</span>}
        <code>{shown.join("\n")}</code>
      </pre>
      {collapsible && (
        <button type="button" className="tv-expand" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "collapse" : `… ${lines.length - maxLines} more lines`}
        </button>
      )}
    </div>
  );
}

// ── DiffBlock ──────────────────────────────────────────────────

export function DiffBlock({ diff, maxLines = 80 }: { diff: string; maxLines?: number }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => stripAnsi(diff).replace(/\n+$/, "").split("\n"), [diff]);
  const collapsible = lines.length > maxLines + 1;
  const shown = collapsible && !expanded ? lines.slice(0, maxLines) : lines;

  return (
    <div className="tv-out">
      <div className="tv-diff">
        {shown.map((line, i) => {
          let cls = "";
          if (line.trim().length === 0) cls = "--gap";
          else if (line.startsWith("+")) cls = "--add";
          else if (line.startsWith("-")) cls = "--del";
          else if (line.startsWith("@@")) cls = "--hunk";
          return (
            <div key={i} className={`tv-diff-row${cls ? ` tv-diff-row${cls}` : ""}`}>
              {line.trim().length === 0 ? "…" : line}
            </div>
          );
        })}
      </div>
      {collapsible && (
        <button type="button" className="tv-expand" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "collapse" : `… ${lines.length - maxLines} more lines`}
        </button>
      )}
    </div>
  );
}

// ── Note ──────────────────────────────────────────────────────

export function Note({ tone, children }: { tone?: "err" | "warn" | "ok"; children: ReactNode }): ReactNode {
  if (children == null || children === "") return null;
  return <div className={`tv-note${tone ? ` tv-note--${tone}` : ""}`}>{children}</div>;
}

// ── Row ──────────────────────────────────────────────────────

export function Row({ k, children }: { k?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="tv-row">
      {k != null && <span className="tv-row-k">{k}</span>}
      <span className="tv-row-val">{children}</span>
    </div>
  );
}

// ── InvalidArg ──────────────────────────────────────────────

export function InvalidArg({ what }: { what?: string }): ReactNode {
  return <span className="tv-invalid">{what ? `invalid ${what}` : "invalid"}</span>;
}
