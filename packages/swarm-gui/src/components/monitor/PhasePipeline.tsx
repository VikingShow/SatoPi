import { useSwarmStore } from "../../stores/swarm-store";

const PHASES = ["Plan", "Workers", "Debate", "Review", "Verdict"];

export default function PhasePipeline() {
  const swarmState = useSwarmStore((s) => s.swarmState);
  const phase = swarmState?.roundtablePhase ?? "";
  const iter = swarmState?.loopIteration ?? 0;
  const maxIter = swarmState?.targetCount ?? 0;

  function getPhaseStatus(p: string): "done" | "active" | "pending" {
    if (phase.includes("Passed") || phase === "Completed") return "done";
    if (phase.includes("Workers") && p === "Workers") return "active";
    if (phase.includes("Cloners") && (p === "Review" || p === "Debate")) return "active";
    if (phase === p) return "active";
    return "pending";
  }

  return (
    <div className="flex items-center gap-1 px-4 py-2 border-b border-background-border bg-background-card">
      {PHASES.map((p, i) => {
        const status = getPhaseStatus(p);
        return (
          <div key={p} className="flex items-center gap-1">
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
