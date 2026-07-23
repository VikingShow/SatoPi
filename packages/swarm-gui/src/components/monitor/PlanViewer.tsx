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
import { Button } from "../ui/button";

export default function PlanViewer() {
  const planVersion = useSwarmStore((s) => s.planVersion);
  const phase = useSwarmStore((s) => s.phase);
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
    if (phase === "stage") {
      return (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-amber-500/25 bg-amber-950/20 px-3 py-2">
          <span className="text-[11px] text-amber-300/90">
            The swarm is running. Pause before editing so workers don't read a half-written plan.
          </span>
          <Button
            variant="default"
            size="xs"
            onClick={() => pauseRun()}
            className="bg-primary/80 hover:bg-primary"
          >
            <Pause size={12} /> Pause
          </Button>
        </div>
      );
    }
    if (phase === "paused") {
      return (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-emerald-500/25 bg-emerald-950/20 px-3 py-2">
          <span className="text-[11px] text-emerald-300/90">
            {isDirty ? "Save your changes, then resume to apply the updated plan." : "Loop paused. Resume when you're done editing."}
          </span>
          <Button
            variant="default"
            size="xs"
            onClick={() => resumeRun()}
            disabled={isDirty}
            className="bg-status-success/80 hover:bg-status-success"
            title={isDirty ? "Save first" : "Resume the loop"}
          >
            <Play size={12} /> Resume
          </Button>
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
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setMode("edit")}
            title="Edit plan"
          >
            <Pencil size={12} />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => { setMode("preview"); setEditContent(content); }}
            title="Preview"
          >
            <Eye size={12} />
          </Button>
        )}

        {/* Save (edit mode only) */}
        {mode === "edit" && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={savePlan}
            disabled={!isDirty || saving}
            className={saved ? "text-status-success" : isDirty && !saving ? "text-primary" : "text-muted-foreground/60"}
            title="Save"
          >
            {saved ? <Check size={12} /> : <Save size={12} />}
          </Button>
        )}

        {/* Monaco toggle (edit mode only) */}
        {mode === "edit" && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setUseMonaco((v) => !v)}
            className={useMonaco ? "text-status-info" : ""}
            title={useMonaco ? "Switch to textarea" : "Switch to Monaco Editor"}
          >
            <Code2 size={12} />
          </Button>
        )}

        {/* Refresh */}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={loadPlan}
          title="Refresh"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </Button>

        {/* Fullscreen */}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setFullscreen(true)}
          title="Expand"
        >
          <Maximize2 size={12} />
        </Button>
      </div>
    );
  }

  // ── Markdown content ──
  function MarkdownContent() {
    if (loading) {
      return (
        <div className="flex items-center justify-center py-4">
          <RefreshCw size={14} className="text-muted-foreground/60 animate-spin" />
        </div>
      );
    }
    if (error) {
      return <div className="text-xs text-muted-foreground/60 italic py-2">{error}</div>;
    }
    if (!content) {
      return <div className="text-xs text-muted-foreground/60 italic py-2">No plan yet. Start a planning dialog to generate one, or switch to edit mode to create manually.</div>;
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
        className="w-full h-full bg-background-elevated text-foreground text-xs font-mono p-3 rounded-lg border border-border focus:border-primary/50 focus:outline-hidden resize-none"
        style={{ minHeight: "200px" }}
        placeholder="# Plan title&#10;&#10;Write your plan in Markdown..."
        spellCheck={false}
      />
    );
  }

  return (
    <>
      {/* ── Inline panel (in ContextPanel) ── */}
      <div className="border-b border-border">
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
            {collapsed ? <ChevronRight size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
            <FileText size={14} className="text-primary" />
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Plan</span>
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
            className="flex flex-col w-full max-w-5xl h-[90vh] mx-auto mt-[5vh] bg-background-card rounded-2xl border border-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <FileText size={16} className="text-primary" />
                <span className="text-sm font-medium text-foreground">plan.md</span>
                {path && <span className="text-xs text-muted-foreground/60">{path}</span>}
                {isDirty && <span className="text-xs text-primary">● unsaved</span>}
              </div>
              <div className="flex items-center gap-2">
                <Toolbar />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setFullscreen(false)}
                >
                  <X size={16} />
                </Button>
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
