import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  FileText, ChevronDown, ChevronRight, RefreshCw,
  Maximize2, X, Pencil, Eye, Save, Check, Code2, Pause, Play,
} from "lucide-react";
import { api } from "../../lib/api-client";
import { useSwarmStore } from "../../stores/swarm-store";
import { CodeEditor } from "./CodeEditor";

export default function PlanViewer() {
  const planVersion = useSwarmStore((s) => s.planVersion);
  const loopPhase = useSwarmStore((s) => s.loopPhase);
  const pauseRun = useSwarmStore((s) => s.pauseRun);
  const resumeRun = useSwarmStore((s) => s.resumeRun);
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
  const [useMonaco, setUseMonaco] = useState(false);

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

  // ── Pause→edit→resume closed loop ──
  // Editing plan.md while the swarm is actively running is unsafe: workers may
  // read a half-written plan mid-iteration. Guide the user to pause first, then
  // resume after saving so the fresh plan is picked up cleanly next iteration.
  function EditLifecycleBanner() {
    if (mode !== "edit") return null;
    if (loopPhase === "running") {
      return (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-amber-500/25 bg-amber-950/20 px-3 py-2">
          <span className="text-[11px] text-amber-300/90">
            The swarm is running. Pause before editing so workers don't read a half-written plan.
          </span>
          <button
            onClick={() => pauseRun()}
            className="flex shrink-0 items-center gap-1 rounded bg-amber-600/80 px-2 py-1 text-xs font-medium text-white hover:bg-amber-500 transition-colors"
          >
            <Pause size={12} /> Pause
          </button>
        </div>
      );
    }
    if (loopPhase === "paused") {
      return (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-emerald-500/25 bg-emerald-950/20 px-3 py-2">
          <span className="text-[11px] text-emerald-300/90">
            {isDirty ? "Save your changes, then resume to apply the updated plan." : "Loop paused. Resume when you're done editing."}
          </span>
          <button
            onClick={() => resumeRun()}
            disabled={isDirty}
            className="flex shrink-0 items-center gap-1 rounded bg-emerald-600/80 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={isDirty ? "Save first" : "Resume the loop"}
          >
            <Play size={12} /> Resume
          </button>
        </div>
      );
    }
    return null;
  }

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

        {/* Monaco toggle (edit mode only) */}
        {mode === "edit" && (
          <button
            onClick={() => setUseMonaco((v) => !v)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors cursor-pointer ${
              useMonaco ? "text-blue-400 bg-blue-500/10" : "text-neutral-500 hover:text-neutral-300"
            }`}
            title={useMonaco ? "Switch to textarea" : "Switch to Monaco Editor"}
          >
            <Code2 size={12} />
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
      return <div className="text-xs text-neutral-600 italic py-2">{error}</div>;
    }
    if (!content) {
      return <div className="text-xs text-neutral-600 italic py-2">No plan yet. Start a planning dialog to generate one, or switch to edit mode to create manually.</div>;
    }
    return (
      <div className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    );
  }

  // ── Editor ──
  function Editor() {
    if (useMonaco) {
      return (
        <CodeEditor
          value={editContent}
          language="markdown"
          path={path || "plan.md"}
          onChange={(v) => setEditContent(v ?? "")}
          height="350px"
        />
      );
    }
    return (
      <textarea
        value={editContent}
        onChange={(e) => setEditContent(e.target.value)}
        className="w-full h-full bg-background-elevated text-neutral-200 text-xs font-mono p-3 rounded-lg border border-background-border focus:border-primary/50 focus:outline-hidden resize-none"
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
        <div
          role="button"
          tabIndex={0}
          onClick={() => setCollapsed(!collapsed)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setCollapsed(!collapsed);
            }
          }}
          className="w-full flex items-center justify-between px-3 py-2 hover:bg-background-elevated/50 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-1.5">
            {collapsed ? <ChevronRight size={14} className="text-neutral-500" /> : <ChevronDown size={14} className="text-neutral-500" />}
            <FileText size={14} className="text-primary" />
            <span className="text-xs font-medium text-neutral-400 uppercase tracking-wider">Plan</span>
            {isDirty && <span className="w-1.5 h-1.5 rounded-full bg-primary" title="Unsaved changes" />}
          </div>
          {!collapsed && (
            /* Toolbar buttons — stop click propagation so they don't toggle the panel */
            <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-1">
              <Toolbar compact />
            </div>
          )}
        </div>

        {!collapsed && (
          <div className="px-3 pb-3 max-h-80 overflow-y-auto">
            <EditLifecycleBanner />
            {mode === "preview" ? <MarkdownContent /> : <Editor />}
          </div>
        )}
      </div>

      {/* ── Fullscreen modal ── */}
      {fullscreen && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-xs"
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
              <EditLifecycleBanner />
              {mode === "preview" ? <MarkdownContent /> : <Editor />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
