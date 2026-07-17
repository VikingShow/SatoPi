import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  FileText, ChevronDown, ChevronRight, RefreshCw,
  Maximize2, X, Pencil, Eye, Save, Check,
} from "lucide-react";
import { api } from "../../lib/api-client";
import { useSwarmStore } from "../../stores/swarm-store";

export default function PlanViewer() {
  const planVersion = useSwarmStore((s) => s.planVersion);
  const [content, setContent] = useState("");
  const [editContent, setEditContent] = useState("");
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  async function loadPlan() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getPlan();
      if (res.error) {
        setError(res.error);
        setContent("");
      } else {
        setContent(res.content);
        setEditContent(res.content);
        setPath(res.path ?? "");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function savePlan() {
    setSaving(true);
    setSaved(false);
    try {
      const res = await api.savePlan(editContent);
      if (res.success) {
        setContent(editContent);
        setSaved(true);
        setPath(res.path ?? path);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  // Auto-refresh plan when planVersion changes (triggered by SSE plan-updated event)
  useEffect(() => {
    loadPlan();
  }, [planVersion]);

  // Initial load
  useEffect(() => {
    loadPlan();
  }, []);

  const isDirty = editContent !== content;

  // ── Shared toolbar ──
  function Toolbar({ compact = false }: { compact?: boolean }) {
    return (
      <div className="flex items-center gap-1">
        {/* Mode toggle */}
        {mode === "preview" ? (
          <button
            onClick={() => setMode("edit")}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors ${compact ? "text-neutral-500 hover:text-neutral-300" : "text-neutral-400 hover:text-neutral-200 bg-background-elevated"}`}
            title="Edit plan"
          >
            <Pencil size={12} />
          </button>
        ) : (
          <button
            onClick={() => { setMode("preview"); setEditContent(content); }}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors ${compact ? "text-neutral-500 hover:text-neutral-300" : "text-neutral-400 hover:text-neutral-200 bg-background-elevated"}`}
            title="Preview"
          >
            <Eye size={12} />
          </button>
        )}

        {/* Save (edit mode only) */}
        {mode === "edit" && (
          <button
            onClick={savePlan}
            disabled={!isDirty || saving}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors ${
              saved ? "text-status-success bg-status-success/10" :
              isDirty && !saving ? "text-primary bg-primary/10 hover:bg-primary/20" :
              "text-neutral-600 bg-background-elevated"
            }`}
            title="Save"
          >
            {saved ? <Check size={12} /> : <Save size={12} />}
          </button>
        )}

        {/* Refresh */}
        <button
          onClick={loadPlan}
          className="text-neutral-600 hover:text-neutral-400 transition-colors p-1"
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>

        {/* Fullscreen */}
        <button
          onClick={() => setFullscreen(true)}
          className="text-neutral-600 hover:text-neutral-400 transition-colors p-1"
          title="Expand"
        >
          <Maximize2 size={12} />
        </button>
      </div>
    );
  }

  // ── Markdown content ──
  function MarkdownContent() {
    if (loading) {
      return (
        <div className="flex items-center justify-center py-4">
          <RefreshCw size={14} className="text-neutral-600 animate-spin" />
        </div>
      );
    }
    if (error) {
      return <div className="text-xs text-neutral-600 italic py-2">{error}. Place plan.md in .omp/ directory.</div>;
    }
    if (!content) {
      return <div className="text-xs text-neutral-600 italic py-2">No plan content. Switch to edit mode to create one.</div>;
    }
    return (
      <div className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    );
  }

  // ── Editor ──
  function Editor() {
    return (
      <textarea
        value={editContent}
        onChange={(e) => setEditContent(e.target.value)}
        className="w-full h-full bg-background-elevated text-neutral-200 text-xs font-mono p-3 rounded-lg border border-background-border focus:border-primary/50 focus:outline-none resize-none"
        style={{ minHeight: "200px" }}
        placeholder="# Plan title&#10;&#10;Write your plan in Markdown..."
        spellCheck={false}
      />
    );
  }

  return (
    <>
      {/* ── Inline panel (in ContextPanel) ── */}
      <div className="border-b border-background-border">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full flex items-center justify-between px-3 py-2 hover:bg-background-elevated/50 transition-colors"
        >
          <div className="flex items-center gap-1.5">
            {collapsed ? <ChevronRight size={14} className="text-neutral-500" /> : <ChevronDown size={14} className="text-neutral-500" />}
            <FileText size={14} className="text-primary" />
            <span className="text-xs font-medium text-neutral-400 uppercase tracking-wider">Plan</span>
            {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-primary" title="Unsaved changes" />}
          </div>
          {!collapsed && <Toolbar compact />}
        </button>

        {!collapsed && (
          <div className="px-3 pb-3 max-h-80 overflow-y-auto">
            {mode === "preview" ? <MarkdownContent /> : <Editor />}
          </div>
        )}
      </div>

      {/* ── Fullscreen modal ── */}
      {fullscreen && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm"
          onClick={() => setFullscreen(false)}
        >
          <div
            className="flex flex-col w-full max-w-5xl h-[90vh] mx-auto mt-[5vh] bg-background-card rounded-2xl border border-background-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-background-border">
              <div className="flex items-center gap-2">
                <FileText size={16} className="text-primary" />
                <span className="text-sm font-medium text-neutral-200">plan.md</span>
                {path && <span className="text-xs text-neutral-600">{path}</span>}
                {isDirty && <span className="text-xs text-primary">● unsaved</span>}
              </div>
              <div className="flex items-center gap-2">
                <Toolbar />
                <button
                  onClick={() => setFullscreen(false)}
                  className="text-neutral-500 hover:text-neutral-300 transition-colors p-1"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* Modal content */}
            <div className="flex-1 overflow-y-auto p-5">
              {mode === "preview" ? <MarkdownContent /> : <Editor />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
