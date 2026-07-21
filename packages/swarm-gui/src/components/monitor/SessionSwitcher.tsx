/**
 * SessionSwitcher — top-bar dropdown that lists all swarm sessions and lets
 * the user switch between them.
 *
 * Clicking the current session name opens a popover with:
 * - List of all sessions (current + historical)
 * - Each row: name, status, last activity, message count
 * - Click a session to view it in read-only mode
 * - "Back to live" button when viewing a historical session
 * - "+ New session" button at the bottom
 */

import { useState, useRef, useEffect } from "react";
import { useSwarmStore } from "../../stores/swarm-store";
import { useSessionStore } from "../../stores/session-store";
import { ChevronDown, History, Play, Check, AlertCircle, Loader2, RotateCcw, Plus, X, FolderOpen, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

type RunMeta = {
  name: string;
  dir: string;
  lastActivity: string | null;
  messageCount: number;
  status: "idle" | "running" | "completed" | "failed";
};

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

function StatusBadge({ status }: { status: RunMeta["status"] }) {
  if (status === "running") {
    return (
      <span className="flex items-center gap-1 text-[10px] font-medium text-amber-400">
        <Loader2 size={9} className="animate-spin" />
        RUN
      </span>
    );
  }
  if (status === "completed") {
    return (
      <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-400">
        <Check size={9} />
        DONE
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="flex items-center gap-1 text-[10px] font-medium text-red-400">
        <AlertCircle size={9} />
        FAIL
      </span>
    );
  }
  return <span className="text-[10px] font-medium text-neutral-600">IDLE</span>;
}

export default function SessionSwitcher() {
  const runs = useSessionStore((s) => s.runs);
  const activeSwarm = useSessionStore((s) => s.activeSwarm);
  const viewingSession = useSessionStore((s) => s.viewingSession);
  const loadRuns = useSessionStore((s) => s.loadRuns);
  const switchToSession = useSessionStore((s) => s.switchToSession);
  const backToCurrent = useSessionStore((s) => s.backToCurrent);
  const newSession = useSessionStore((s) => s.newSession);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const isRunning = useSwarmStore((s) => s.isRunning);
  const swarmState = useSwarmStore((s) => s.swarmState);
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [newBusy, setNewBusy] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Refresh run list every 10s
  useEffect(() => {
    const id = setInterval(() => loadRuns(), 10_000);
    return () => clearInterval(id);
  }, [loadRuns]);

  // Close popover on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Merge live state with persisted runs
  const liveRun: RunMeta | null = swarmState?.name
    ? {
        name: swarmState.name,
        dir: `.swarm_${swarmState.name}`,
        lastActivity: new Date(swarmState.startedAt).toISOString(),
        messageCount: 0,
        status: (swarmState.status as RunMeta["status"]) ?? "idle",
      }
    : null;
  const allRuns: RunMeta[] = [];
  if (liveRun && !runs.find((r) => r.name === liveRun.name)) allRuns.push(liveRun);
  for (const r of runs) allRuns.push(r);

  // Displayed name in the trigger button
  const displayedName = viewingSession
    ? viewingSession
    : activeSwarm;

  async function handleNew() {
    if (isRunning) {
      toast.error("Cannot start a new session while a swarm is running", {
        description: "Stop the current run first.",
      });
      return;
    }
    setNewBusy(true);
    try {
      const name = await newSession();
      if (name) toast.success(`New session: ${name}`);
    } finally {
      setNewBusy(false);
    }
  }

  return (
    <div className="relative" ref={popoverRef}>
      {/* Trigger button — shows current session name */}
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-sm transition-colors cursor-pointer ${
          open
            ? "bg-primary/15 text-primary"
            : "text-neutral-300 hover:text-neutral-100 hover:bg-background-elevated"
        }`}
        title="Switch session"
      >
        {viewingSession ? (
          <History size={13} className="text-amber-400" />
        ) : (
          <Play size={13} className="text-emerald-400" />
        )}
        <span className="font-medium tracking-tight max-w-[180px] truncate">{displayedName}</span>
        <ChevronDown size={12} className={`text-neutral-500 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-80 rounded-lg border border-background-border bg-background-card shadow-2xl shadow-black/40 overflow-hidden">
          {/* Header */}
          <div className="px-3 py-2 border-b border-background-border flex items-center justify-between bg-background-elevated/30">
            <span className="text-xs font-medium text-neutral-400 uppercase tracking-wider flex items-center gap-1.5">
              <FolderOpen size={11} className="text-primary" />
              Sessions ({allRuns.length})
            </span>
            {viewingSession && (
              <button
                onClick={() => { backToCurrent(); setOpen(false); }}
                className="flex items-center gap-1 text-[11px] font-medium text-emerald-400 hover:text-emerald-300 transition-colors cursor-pointer"
              >
                <RotateCcw size={10} />
                Back to live
              </button>
            )}
          </div>

          {/* "Viewing historical" banner */}
          {viewingSession && (
            <div className="px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/20 text-[11px] text-amber-300 flex items-center gap-1.5">
              <History size={11} />
              Viewing: <span className="font-mono font-medium">{viewingSession}</span>
            </div>
          )}

          {/* Session list */}
          <div className="max-h-80 overflow-y-auto">
            {allRuns.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-neutral-600">
                No sessions yet
              </div>
            ) : (
              allRuns.map((run) => {
                const isActive = run.name === activeSwarm;
                const isViewing = viewingSession === run.name;
                return (
                  <button
                    key={run.name}
                    onClick={() => {
                      if (isViewing) {
                        backToCurrent();
                      } else {
                        switchToSession(run.name);
                      }
                      setOpen(false);
                    }}
                    className={`group w-full px-3 py-2 flex flex-col gap-1 text-left transition-colors cursor-pointer border-b border-background-border/40 last:border-b-0 ${
                      isViewing
                        ? "bg-primary/10"
                        : isActive
                        ? "bg-emerald-500/5 hover:bg-emerald-500/10"
                        : "hover:bg-background-elevated"
                    }`}
                  >
                    <div className="flex items-center gap-2 w-full">
                      {isActive && !isViewing ? (
                        <Play size={11} className="text-emerald-400 shrink-0" fill="currentColor" />
                      ) : isViewing ? (
                        <History size={11} className="text-amber-400 shrink-0" />
                      ) : (
                        <FolderOpen size={11} className="text-neutral-500 shrink-0" />
                      )}
                      <span className={`text-xs flex-1 truncate font-medium ${
                        isViewing ? "text-primary" : isActive ? "text-emerald-300" : "text-neutral-200"
                      }`}>
                        {run.name}
                      </span>
                      {isViewing && <span className="text-[9px] uppercase tracking-wider text-amber-400 font-bold">VIEW</span>}
                      {isActive && !isViewing && <span className="text-[9px] uppercase tracking-wider text-emerald-400 font-bold">LIVE</span>}
                      {/* Delete — confirmed via native confirm() to avoid accidental data loss */}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`Delete session “${run.name}”? This cannot be undone.`)) {
                            deleteSession(run.name);
                          }
                        }}
                        className="opacity-0 group-hover:opacity-100 hover:opacity-100 ml-auto shrink-0 p-0.5 rounded text-neutral-700 hover:text-red-400 hover:bg-red-500/10 transition-all cursor-pointer"
                        title="Delete session"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                    <div className="flex items-center justify-between gap-2 pl-5">
                      <StatusBadge status={run.status} />
                      <span className="text-[10px] text-neutral-600 font-mono">
                        {timeAgo(run.lastActivity)} · {run.messageCount} msgs
                      </span>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* New session action */}
          <div className="border-t border-background-border p-2 bg-background-elevated/30">
            <button
              onClick={handleNew}
              disabled={newBusy || isRunning}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-neutral-200 bg-background-card hover:bg-primary/15 hover:text-primary border border-background-border rounded-md transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              title={isRunning ? "Stop the current run first" : "Start a fresh session"}
            >
              {newBusy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
              New session
              {isRunning && <span className="text-[10px] text-status-warning ml-1">(stop current first)</span>}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
