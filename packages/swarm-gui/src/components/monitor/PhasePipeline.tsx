import { useSwarmStore } from "../../stores/swarm-store";
import { Check, Loader2 } from "lucide-react";

import type { LoopPhase } from "../../lib/types";

/**
 * PhasePipeline — user-readable 5-step progress bar.
 *
 * Internal phases mapped to user-facing terminology:
 *   Before Loop (dialog+debate+confirm) → Planning → Refining
 *   Workers running → Working
 *   Cloner review + verdict → Reviewing
 *   After Loop → Summary
 */
interface Step {
  key: string;
  label: string;
  internalPhases: LoopPhase[];
}

const STEPS: Step[] = [
  { key: "planning", label: "Plan", internalPhases: ["before-loop-dialog", "before-loop-debate"] },
  { key: "refining", label: "Refine", internalPhases: ["before-loop-confirm"] },
  { key: "working", label: "Work", internalPhases: ["running"] },
  { key: "reviewing", label: "Review", internalPhases: [] },
  { key: "summary", label: "Summary", internalPhases: ["after-loop"] },
];

export default function PhasePipeline() {
  const swarmState = useSwarmStore((s) => s.swarmState);
  const loopPhase = useSwarmStore((s) => s.loopPhase);
  const phase = swarmState?.roundtablePhase ?? "";
  const iter = swarmState?.loopIteration ?? 0;
  const maxIter = swarmState?.targetCount ?? 0;

  if (loopPhase === "idle") return null;

  function getStepStatus(index: number): "done" | "active" | "pending" {
    const step = STEPS[index];
    if (!step) return "pending";

    // Active: current loopPhase matches
    if (step.internalPhases.includes(loopPhase)) return "active";

    // In Running phase, check roundtablePhase for Review/After Loop
    if (loopPhase === "running") {
      if (phase.includes("Review") && step.key === "reviewing") return "active";
      if (phase.includes("After Loop") && step.key === "summary") return "active";
      if (phase.includes("After Loop completed")) {
        return step.key === "summary" ? "done" : "done";
      }
    }

    // Blocked: prior steps done
    if (loopPhase === "blocked") {
      return index < 3 ? "done" : "pending";
    }

    // Find active index to mark earlier steps as done
    const activeIdx = STEPS.findIndex(
      (s) =>
        s.internalPhases.includes(loopPhase) ||
        (loopPhase === "running" && phase.includes(s.key === "reviewing" ? "Review" : s.key === "summary" ? "After Loop" : "")),
    );
    if (activeIdx >= 0 && index < activeIdx) return "done";

    return "pending";
  }

  return (
    <div className="flex items-center justify-center gap-0 px-4 py-2 border-b border-border bg-background-card overflow-x-auto">
      {STEPS.map((step, i) => {
        const status = getStepStatus(i);
        const isLast = i === STEPS.length - 1;

        return (
          <div key={step.key} className="flex items-center gap-0 flex-shrink-0">
            <div className="flex items-center gap-1.5">
              {status === "done" ? (
                <Check size={14} className="text-success flex-shrink-0" />
              ) : status === "active" ? (
                <Loader2 size={14} className="text-warning animate-spin flex-shrink-0" />
              ) : (
                <div className="w-3.5 h-3.5 rounded-full border-2 border-neutral-700 flex-shrink-0" />
              )}

              <span
                className={`text-xs font-medium ${
                  status === "done"
                    ? "text-success"
                    : status === "active"
                      ? "text-warning"
                      : "text-fg-faint"
                }`}
              >
                {step.label}
                {step.key === "working" && status === "active" && (
                  <span className="text-fg-faint font-normal ml-0.5">
                    {iter}/{maxIter}
                  </span>
                )}
              </span>
            </div>

            {!isLast && (
              <div
                className={`w-8 h-px mx-1.5 ${status === "done" ? "bg-success/40" : "bg-neutral-800"}`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
