import { useSwarmStore } from "../../stores/swarm-store";
import type { LoopPhase } from "../../lib/types";

// All phases including Before Loop stages
const ALL_PHASES = ["Plan", "Dialog", "Debate", "Confirm", "Workers", "Review", "Verdict", "After Loop"];

// In-loop phases (original)
const IN_LOOP_PHASES = ["Plan", "Workers", "Debate", "Review", "Verdict", "After Loop"];

export default function PhasePipeline() {
  const swarmState = useSwarmStore((s) => s.swarmState);
  const loopPhase = useSwarmStore((s) => s.loopPhase);
  const phase = swarmState?.roundtablePhase ?? "";
  const iter = swarmState?.loopIteration ?? 0;
  const maxIter = swarmState?.targetCount ?? 0;

  // Determine which phase set to show
  const showBeforeLoop = loopPhase === "before-loop-dialog" || loopPhase === "before-loop-debate" || loopPhase === "before-loop-confirm";
  const phases = showBeforeLoop ? ALL_PHASES : IN_LOOP_PHASES;

  function getPhaseStatus(p: string): "done" | "active" | "pending" {
    // Before-loop phase tracking
    if (loopPhase === "before-loop-dialog") {
      if (p === "Plan") return "done";
      if (p === "Dialog") return "active";
      return "pending";
    }
    if (loopPhase === "before-loop-debate") {
      if (p === "Plan" || p === "Dialog") return "done";
      if (p === "Debate") return "active";
      return "pending";
    }
    if (loopPhase === "before-loop-confirm") {
      if (p === "Plan" || p === "Dialog" || p === "Debate") return "done";
      if (p === "Confirm") return "active";
      return "pending";
    }

    // In-loop phase tracking (original logic)
    // After Loop completed → everything is done
    if (phase.includes("After Loop completed")) return "done";
    // After Loop in progress
    if (phase.includes("After Loop") && p === "After Loop") return "active";
    // After Loop started → all in-loop phases are done
    if (phase.includes("After Loop") && p !== "After Loop") return "done";
    // Normal in-loop phase tracking
    if (phase.includes("Passed") || phase === "Completed") {
      return p === "After Loop" ? "pending" : "done";
    }
    if (phase.includes("Workers") && p === "Workers") return "active";
    if (phase.includes("Cloners") && (p === "Review" || p === "Debate")) return "active";
    if (phase === p) return "active";

    // When running, Plan is done, Workers is active by default
    if (loopPhase === "running" && p === "Plan") return "done";
    if (loopPhase === "running" && p === "Workers") return "active";

    // After-loop phase
    if (loopPhase === "after-loop" && p === "After Loop") return "active";
    if (loopPhase === "after-loop") return "done";

    return "pending";
  }

  return (
    <div className="flex items-center gap-1 px-4 py-2 border-b border-background-border bg-background-card overflow-x-auto">
      {phases.map((p, i) => {
        const status = getPhaseStatus(p);
        return (
          <div key={p} className="flex items-center gap-1 flex-shrink-0">
            {i > 0 && <span className="text-neutral-700 text-xs">--</span>}
            <div className="flex items-center gap-1.5">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  status === "done" ? "bg-status-success" :
                  status === "active" ? "bg-status-warning animate-pulse-ring" :
                  "bg-neutral-700"
                }`}
              />
              <span className={`text-xs ${
                status === "done" ? "text-status-success" :
                status === "active" ? "text-status-warning" :
                "text-neutral-600"
              }`}>
                {p}
                {p === "Workers" && status === "active" && ` R${iter}/${maxIter}`}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
