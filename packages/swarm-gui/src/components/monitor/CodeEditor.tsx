/**
 * CodeEditor — Monaco Editor wrapper with lazy loading.
 *
 * Supports read-only preview mode and full edit mode.
 * DiffViewer shows side-by-side comparison of code changes.
 */
import { lazy, Suspense, useState } from "react";
import type { OnMount } from "@monaco-editor/react";
import { Loader2 } from "lucide-react";

const Editor = lazy(() => import("@monaco-editor/react"));

// ── CodeEditor ────────────────────────────────────────────────────
interface CodeEditorProps {
  value: string;
  language?: string;
  readOnly?: boolean;
  path?: string;
  onChange?: (value: string | undefined) => void;
  height?: string;
}

export function CodeEditor({
  value,
  language,
  readOnly = false,
  path,
  onChange,
  height = "400px",
}: CodeEditorProps) {
  const [mounted, setMounted] = useState(false);

  const handleMount: OnMount = (editor) => {
    setMounted(true);
    // Auto-detect language from file path if not specified
    if (!language && path) {
      const model = editor.getModel();
      if (model) {
        const detected = detectLanguage(path);
        if (detected) {
          import("@monaco-editor/react").then((m) => {
            m.loader.config({});
          });
        }
      }
    }
  };

  return (
    <div className="rounded-lg overflow-hidden border border-neutral-800">
      <Suspense
        fallback={
          <div className="flex items-center justify-center bg-[#1e1e1e]" style={{ height }}>
            <Loader2 size={20} className="animate-spin text-neutral-500" />
          </div>
        }
      >
        <Editor
          height={height}
          language={language ?? (path ? detectLanguage(path) : "plaintext")}
          value={value}
          onChange={onChange}
          onMount={handleMount}
          options={{
            readOnly,
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            wordWrap: "on",
            padding: { top: 12, bottom: 12 },
            theme: "vs-dark",
          }}
          loading={
            <div className="flex items-center justify-center bg-[#1e1e1e]" style={{ height }}>
              <Loader2 size={20} className="animate-spin text-neutral-500" />
            </div>
          }
        />
      </Suspense>
    </div>
  );
}

// ── DiffViewer ────────────────────────────────────────────────────
interface DiffViewerProps {
  original: string;
  modified: string;
  language?: string;
  path?: string;
  height?: string;
}

export function DiffViewer({
  original,
  modified,
  language,
  path,
  height = "400px",
}: DiffViewerProps) {
  const lang = language ?? (path ? detectLanguage(path) : "plaintext");

  return (
    <div className="rounded-lg overflow-hidden border border-neutral-800 bg-[#1e1e1e]">
      <div className="flex items-center justify-between px-3 py-2 border-b border-neutral-700 text-xs text-neutral-400">
        <span>Diff View</span>
        {path && <span className="font-mono text-neutral-500">{path}</span>}
        <span className="text-neutral-500">
          <span className="text-red-400">{countLines(original)}</span>
          {" → "}
          <span className="text-emerald-400">{countLines(modified)}</span>
          {" lines"}
        </span>
      </div>
      <Suspense
        fallback={
          <div className="flex items-center justify-center" style={{ height }}>
            <Loader2 size={20} className="animate-spin text-neutral-500" />
          </div>
        }
      >
        <Editor
          height={height}
          language={lang}
          original={original}
          modified={modified}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            fontSize: 13,
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            wordWrap: "on",
            padding: { top: 12, bottom: 12 },
            theme: "vs-dark",
            renderSideBySide: true,
          }}
        />
      </Suspense>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────
function detectLanguage(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", rs: "rust", go: "go", java: "java", rb: "ruby",
    sh: "shell", bash: "shell", zsh: "shell",
    yml: "yaml", yaml: "yaml", json: "json", toml: "ini",
    md: "markdown", sql: "sql", html: "html", css: "css",
    scss: "scss", less: "less", xml: "xml", svg: "xml",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp",
  };
  return map[ext ?? ""] ?? "plaintext";
}

function countLines(text: string): number {
  return text.split("\n").length;
}
