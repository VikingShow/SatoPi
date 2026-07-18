import { useState } from "react";
import { AlertTriangle, Play, SkipForward, OctagonX, Loader2 } from "lucide-react";
import { useSwarmStore } from "../../stores/swarm-store";
import type { BlockerResolution } from "../../lib/types";

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

  if (loopPhase !== "blocked") return null;

  const handleResolve = async (decision: BlockerResolution) => {
    setPending(decision);
    await resolveBlocker(decision);
    setPending(null);
  };

  const ctx = blockerContext;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Glassmorphism backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-xs" />

      {/* Dialog card */}
      <div className="relative w-full max-w-2xl mx-4 rounded-card border border-red-500/30 bg-neutral-900/80 backdrop-blur-xl shadow-2xl shadow-red-500/10">
        {/* Header — amber/red accent bar */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-red-500/20 bg-linear-to-r from-red-950/40 to-amber-950/30 rounded-t-card">
          <AlertTriangle size={24} className="text-amber-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-amber-300">Loop Blocked</h2>
            <p className="text-xs text-neutral-500 mt-0.5">
              The swarm is stuck and needs your decision to proceed.
            </p>
          </div>
        </div>

        {/* Body — blocker context */}
        <div className="px-6 py-5 space-y-4 max-h-[50vh] overflow-y-auto">
          {ctx ? (
            <>
              {/* Reason */}
              <div>
                <span className="text-xs font-medium uppercase tracking-wide text-neutral-600">Reason</span>
                <p className="text-sm text-red-300 mt-1">{ctx.reason}</p>
              </div>

              {/* Stats row */}
              <div className="flex gap-6">
                <div>
                  <span className="text-xs font-medium uppercase tracking-wide text-neutral-600">Iteration</span>
                  <p className="text-lg font-mono text-neutral-200 mt-0.5">{ctx.iteration}</p>
                </div>
                <div>
                  <span className="text-xs font-medium uppercase tracking-wide text-neutral-600">Stagnation</span>
                  <p className="text-lg font-mono text-amber-400 mt-0.5">{ctx.stagnationCount}</p>
                </div>
              </div>

              {/* Worker crash counts */}
              {Object.keys(ctx.workerCrashCounts).length > 0 && (
                <div>
                  <span className="text-xs font-medium uppercase tracking-wide text-neutral-600">Worker Crashes</span>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {Object.entries(ctx.workerCrashCounts)
                      .filter(([, count]) => count > 0)
                      .map(([worker, count]) => (
                        <span
                          key={worker}
                          className={`px-2 py-0.5 rounded text-xs font-mono ${
                            count >= 3
                              ? "bg-red-500/20 text-red-300 border border-red-500/30"
                              : "bg-neutral-800 text-neutral-400 border border-neutral-700"
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
                  <span className="text-xs font-medium uppercase tracking-wide text-neutral-600">Last Cloner Findings</span>
                  <ul className="mt-1 space-y-1">
                    {ctx.lastFindings.slice(0, 5).map((finding, i) => (
                      <li key={i} className="text-sm text-neutral-400 flex gap-2">
                        <span className="text-neutral-700 shrink-0">{i + 1}.</span>
                        <span className="truncate">{finding}</span>
                      </li>
                    ))}
                    {ctx.lastFindings.length > 5 && (
                      <li className="text-xs text-neutral-600">...and {ctx.lastFindings.length - 5} more</li>
                    )}
                  </ul>
                </div>
              )}

              {/* Last worker output preview */}
              {ctx.lastWorkerOutput && (
                <div>
                  <span className="text-xs font-medium uppercase tracking-wide text-neutral-600">Last Worker Output</span>
                  <pre className="mt-1 text-xs text-neutral-500 bg-neutral-950/60 border border-neutral-800 rounded p-3 max-h-32 overflow-auto whitespace-pre-wrap font-mono">
                    {ctx.lastWorkerOutput.slice(0, 2000)}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-neutral-500">Loading blocker context...</p>
          )}
        </div>

        {/* Footer — action buttons */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-neutral-800 bg-neutral-900/50 rounded-b-card">
          <button
            onClick={() => handleResolve("continue")}
            disabled={pending !== null}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-500 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pending === "continue" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            Continue (reset)
          </button>

          <button
            onClick={() => handleResolve("skip")}
            disabled={pending !== null}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-neutral-200 bg-neutral-700 hover:bg-neutral-600 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pending === "skip" ? <Loader2 size={14} className="animate-spin" /> : <SkipForward size={14} />}
            Skip Iteration
          </button>

          <button
            onClick={() => handleResolve("abort")}
            disabled={pending !== null}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-500 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {pending === "abort" ? <Loader2 size={14} className="animate-spin" /> : <OctagonX size={14} />}
            Abort Run
          </button>
        </div>
      </div>
    </div>
  );
}
