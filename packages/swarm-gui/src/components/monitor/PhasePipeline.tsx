import { useSwarmStore } from "../../stores/swarm-store";
import { Check, Loader2, AlertTriangle, Pause } from "lucide-react";

import type { Chapter } from "../../lib/types";

/**
 * PhasePipeline — user-readable 6-step progress bar with sub-steps.
 *
 *   Plan  →  Refine  →  Work  →  Review  →  Blocked  →  Summary
 *
 * Sub-steps are derived from `roundtablePhase` for finer-grained display
 * during the "Work" and "Review" steps.
 */
interface Step {
  key: string;
  label: string;
  internalPhases: Chapter[];
  /** Sub-step labels derived from roundtablePhase string matching. */
  subStepPatterns?: Array<{ match: string; label: string }>;
}

const STEPS: Step[] = [
  {
    key: "planning", label: "Plan",
    internalPhases: ["script", "script-debate"],
  },
  {
    key: "refining", label: "Refine",
    internalPhases: ["script-confirm"],
  },
  {
    key: "working", label: "Work",
    internalPhases: ["stage", "paused"],  // paused is running suspended
    subStepPatterns: [
      { match: "Workers executing", label: "Working" },
      { match: "Debate: challenging", label: "Challenging" },
      { match: "Debate: rebuttal", label: "Rebuttal" },
      { match: "Debate: resolution", label: "Resolution" },
    ],
  },
  {
    key: "reviewing", label: "Review",
    internalPhases: [], // activated by roundtablePhase match during "stage" or "blocked"
    subStepPatterns: [
      { match: "Cloners reviewing", label: "Reviewing" },
    ],
  },
  {
    key: "blocked", label: "Blocked",
    internalPhases: ["blocked"],
  },
  {
    key: "summary", label: "Summary",
    internalPhases: ["curtain"],
  },
];

export default function PhasePipeline() {
  const swarmState = useSwarmStore((s) => s.swarmState);
  const phase = useSwarmStore((s) => s.phase);
  const subPhase = swarmState?.roundtablePhase ?? "";
  const iter = swarmState?.loopIteration ?? 0;
  const maxIter = swarmState?.targetCount ?? 0;

  if (phase === "idle") return null;

  /** Return the active sub-step label for a step, or null. */
  function getSubStep(step: Step): string | null {
    if (!step.subStepPatterns || step.subStepPatterns.length === 0) return null;
    for (const p of step.subStepPatterns) {
      if (phase.includes(p.match)) return p.label;
    }
    return null;
  }

  function getStepStatus(index: number): "done" | "active" | "pending" | "blocked" | "paused" {
    const step = STEPS[index];
    if (!step) return "pending";

    // Blocked phase: special red highlight
    if (step.internalPhases.includes("blocked") && phase === "blocked") return "blocked";

    // Paused phase: show pause indicator on the Work step
    if (phase === "paused" && step.internalPhases.includes("paused")) return "paused";

    // Active: current phase matches
    if (step.internalPhases.includes(phase)) return "active";

    // In Running phase, check roundtablePhase for Review step
    if (phase === "stage") {
      if (phase.includes("Cloners reviewing") && step.key === "reviewing") return "active";
      if (phase.includes("After Loop") && step.key === "summary") return "active";
      if (phase.includes("After Loop completed")) {
        if (step.key === "summary") return "done";
        if (index < STEPS.findIndex((s) => s.key === "summary")) return "done";
      }
    }

    // Blocked: prior steps are done
    if (phase === "blocked") {
      const blockedIdx = STEPS.findIndex((s) => s.key === "blocked");
      if (index < blockedIdx) return "done";
    }

    // Find active index to mark earlier steps as done
    const activeIdx = STEPS.findIndex(
      (s) =>
        s.internalPhases.includes(phase) ||
        (phase === "stage" && phase.includes(
          s.key === "reviewing" ? "Cloners reviewing" : s.key === "summary" ? "After Loop" : "",
        )),
    );
    if (activeIdx >= 0 && index < activeIdx) return "done";

    return "pending";
  }

  return (
    <div className="flex items-center justify-center gap-0 px-4 py-2 border-b border-border bg-background-card overflow-x-auto">
      {STEPS.map((step, i) => {
        const status = getStepStatus(i);
        const isLast = i === STEPS.length - 1;
        const subStep = getSubStep(step);

        return (
          <div key={step.key} className="flex items-center gap-0 flex-shrink-0">
            <div className="flex flex-col items-center">
              <div className="flex items-center gap-1.5">
                {status === "done" ? (
                  <Check size={14} className="text-success flex-shrink-0" />
                ) : status === "blocked" ? (
                  <AlertTriangle size={14} className="text-red-400 flex-shrink-0 animate-pulse" />
                ) : status === "paused" ? (
                  <Pause size={14} className="text-amber-400 flex-shrink-0" />
                ) : status === "active" ? (
                  <Loader2 size={14} className="text-warning animate-spin flex-shrink-0" />
                ) : (
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-border flex-shrink-0" />
                )}

                <span
                  className={`text-xs font-medium ${
                    status === "done"
                      ? "text-success"
                      : status === "blocked"
                        ? "text-red-400"
                        : status === "paused"
                          ? "text-amber-400"
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
              {/* Sub-step label (shown below the main step when active) */}
              {subStep && status === "active" && (
                <span className="text-[9px] text-muted-foreground/50 mt-0.5 leading-none">
                  {subStep}
                </span>
              )}
            </div>

            {!isLast && (
              <div
                className={`w-8 h-px mx-1.5 ${
                  status === "done" ? "bg-success/40" :
                  status === "blocked" ? "bg-red-400/40" :
                  status === "paused" ? "bg-amber-400/40" :
                  "bg-card"
                }`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
