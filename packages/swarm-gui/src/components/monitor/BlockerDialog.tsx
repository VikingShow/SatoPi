import { useState, useEffect } from "react";
import { AlertTriangle, Play, SkipForward, OctagonX, Loader2, Timer } from "lucide-react";
import { useSwarmStore } from "../../stores/swarm-store";
import type { BlockerResolution } from "../../lib/types";

/** Live countdown to the backend's auto-continue deadline. */
function useCountdown(deadline?: number): { remainingMs: number; ratio: number } | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadline]);
  if (!deadline) return null;
  const remainingMs = Math.max(0, deadline - now);
  return { remainingMs, ratio: remainingMs };
}

function formatMs(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * BlockerDialog — modal overlay shown when the loop is blocked.
 *
 * Displays blocker context (iteration, reason, findings, last worker output)
 * and offers three resolution options: Continue (reset), Skip Iteration, Abort Run.
 *
 * Glassmorphism design with red/amber accent for urgency.
 */
export default function BlockerDialog() {
  const loopPhase = useSwarmStore((s) => s.loopPhase);
  const blockerContext = useSwarmStore((s) => s.blockerContext);
  const resolveBlocker = useSwarmStore((s) => s.resolveBlocker);

  const [pending, setPending] = useState<BlockerResolution | null>(null);
  const countdown = useCountdown(blockerContext?.deadline);

  if (loopPhase !== "blocked") return null;

  const handleResolve = async (decision: BlockerResolution) => {
    setPending(decision);
    await resolveBlocker(decision);
    setPending(null);
  };

  const ctx = blockerContext;
  // Fraction of the auto-continue window elapsed (0 → just blocked, 1 → firing).
  const urgency =
    countdown && ctx?.timeoutMs ? 1 - Math.min(1, countdown.remainingMs / ctx.timeoutMs) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Glassmorphism backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-xs" />

      {/* Dialog card */}
      <div className="relative w-full max-w-2xl mx-4 rounded-card border border-red-500/30 bg-background/80 backdrop-blur-xl shadow-2xl shadow-red-500/10">
        {/* Header — amber/red accent bar */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-red-500/20 bg-linear-to-r from-red-950/40 to-amber-950/30 rounded-t-card">
          <AlertTriangle size={24} className="text-amber-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-amber-300">Loop Blocked</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              The swarm is stuck and needs your decision to proceed.
            </p>
          </div>
        </div>

        {/* Body — blocker context */}
        <div className="px-6 py-5 space-y-4 max-h-[50vh] overflow-y-auto">
          {ctx ? (
            <>
              {/* Auto-continue countdown */}
              {countdown && ctx.timeoutMs ? (
                <div className="rounded-md border border-amber-500/20 bg-amber-950/20 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-amber-300/90">
                      <Timer size={13} />
                      Auto-continue in
                    </span>
                    <span className="font-mono text-sm text-amber-200 tabular-nums">
                      {countdown.remainingMs > 0 ? formatMs(countdown.remainingMs) : "now…"}
                    </span>
                  </div>
                  <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-card">
                    <div
                      className="h-full rounded-full bg-linear-to-r from-amber-500 to-red-500 transition-[width] duration-1000 ease-linear"
                      style={{ width: `${Math.round(urgency * 100)}%` }}
                    />
                  </div>
                  <p className="mt-1.5 text-[10px] text-muted-foreground">
                    No decision needed — the swarm will continue automatically if you don't respond.
                  </p>
                </div>
              ) : null}

              {/* Reason */}
              <div>
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/60">Reason</span>
                <p className="text-sm text-red-300 mt-1">{ctx.reason}</p>
              </div>

              {/* Stats row */}
              <div className="flex gap-6">
                <div>
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/60">Iteration</span>
                  <p className="text-lg font-mono text-foreground mt-0.5">{ctx.iteration}</p>
                </div>
                <div>
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/60">Stagnation</span>
                  <p className="text-lg font-mono text-amber-400 mt-0.5">{ctx.stagnationCount}</p>
                </div>
              </div>

              {/* Worker crash counts */}
              {Object.keys(ctx.workerCrashCounts).length > 0 && (
                <div>
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/60">Worker Crashes</span>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {Object.entries(ctx.workerCrashCounts)
                      .filter(([, count]) => count > 0)
                      .map(([worker, count]) => (
                        <span
                          key={worker}
                          className={`px-2 py-0.5 rounded text-xs font-mono ${
                            count >= 3
                              ? "bg-red-500/20 text-red-300 border border-red-500/30"
                              : "bg-card text-muted-foreground border border-border"
                          }`}
                        >
                          {worker}: {count}
                        </span>
                      ))}
                  </div>
                </div>
              )}

              {/* Last findings */}
              {ctx.lastFindings.length > 0 && (
                <div>
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/60">Last Cloner Findings</span>
                  <ul className="mt-1 space-y-1">
                    {ctx.lastFindings.slice(0, 5).map((finding, i) => (
                      <li key={i} className="text-sm text-muted-foreground flex gap-2">
                        <span className="text-muted-foreground/50 shrink-0">{i + 1}.</span>
                        <span className="truncate">{finding}</span>
                      </li>
                    ))}
                    {ctx.lastFindings.length > 5 && (
                      <li className="text-xs text-muted-foreground/60">...and {ctx.lastFindings.length - 5} more</li>
                    )}
                  </ul>
                </div>
              )}

              {/* Last worker output preview */}
              {ctx.lastWorkerOutput && (
                <div>
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/60">Last Worker Output</span>
                  <pre className="mt-1 text-xs text-muted-foreground bg-background/60 border border-border rounded p-3 max-h-32 overflow-auto whitespace-pre-wrap font-mono">
                    {ctx.lastWorkerOutput.slice(0, 2000)}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Loading blocker context...</p>
          )}
        </div>

        {/* Footer — action buttons */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border bg-background/50 rounded-b-card">
          <button
            onClick={() => handleResolve("continue")}
            disabled={pending !== null}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-foreground bg-emerald-600 hover:bg-emerald-500 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pending === "continue" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            Continue (reset)
          </button>

          <button
            onClick={() => handleResolve("skip")}
            disabled={pending !== null}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-foreground bg-background-elevated hover:bg-background-overlay rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pending === "skip" ? <Loader2 size={14} className="animate-spin" /> : <SkipForward size={14} />}
            Skip Iteration
          </button>

          <button
            onClick={() => handleResolve("abort")}
            disabled={pending !== null}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-foreground bg-red-600 hover:bg-red-500 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pending === "abort" ? <Loader2 size={14} className="animate-spin" /> : <OctagonX size={14} />}
            Abort Run
          </button>
        </div>
      </div>
    </div>
  );
}
