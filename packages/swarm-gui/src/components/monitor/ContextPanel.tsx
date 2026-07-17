import { Crown, FileWarning } from "lucide-react";
import { useSwarmStore } from "../../stores/swarm-store";

function WorkerCard({ name, praise, criticism, conflict, status, role }: {
  name: string; praise: number; criticism: number; conflict: number;
  status: string; role?: string;
}) {
  const score = praise - criticism - conflict;
  const scoreColor = score > 0 ? "text-status-success" : score < 0 ? "text-status-danger" : "text-neutral-400";
  const statusDot = status === "completed" ? "bg-status-success" : status === "running" ? "bg-status-warning" : status === "failed" ? "bg-status-danger" : "bg-neutral-600";

  return (
    <div className="bg-background-elevated rounded-card p-2.5 border border-background-border">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
          <span className="text-xs font-medium text-neutral-200">{name}</span>
          {role === "reviewer" && <Crown size={11} className="text-primary" />}
        </div>
        <span className={`text-xs font-mono ${scoreColor}`}>{score > 0 ? "+" : ""}{score}</span>
      </div>
      <div className="flex items-center gap-2 text-xs text-neutral-600">
        <span>{praise}P</span>
        <span>{criticism}C</span>
        <span>{conflict}F</span>
      </div>
    </div>
  );
}

export default function ContextPanel() {
  const swarmState = useSwarmStore((s) => s.swarmState);
  const activities = useSwarmStore((s) => s.activities);

  if (!swarmState) return null;

  const agents = Object.entries(swarmState.agents);
  const workers = agents.filter(([_, a]) => !a.name.startsWith("cloner"));
  const cloners = agents.filter(([_, a]) => a.name.startsWith("cloner"));

  const lastVerdict = [...activities].reverse().find((a) => a.type === "verdict");
  const conflicts = activities.filter((a) => a.type === "conflict");

  return (
    <div className="w-64 flex flex-col border-l border-background-border bg-background-card overflow-y-auto">
      {/* Workers */}
      <div className="px-3 py-2 border-b border-background-border">
        <span className="text-xs font-medium text-neutral-400 uppercase tracking-wider">Workers ({workers.length})</span>
      </div>
      <div className="p-2 space-y-1.5">
        {workers.map(([id, agent]) => (
          <WorkerCard
            key={id}
            name={agent.name}
            praise={agent.praiseCount}
            criticism={agent.criticismCount}
            conflict={agent.conflictCount}
            status={agent.status}
            role={agent.role}
          />
        ))}
      </div>

      {/* Cloners */}
      {cloners.length > 0 && (
        <>
          <div className="px-3 py-2 border-b border-background-border border-t">
            <span className="text-xs font-medium text-neutral-400 uppercase tracking-wider">Cloners ({cloners.length})</span>
          </div>
          <div className="p-2 space-y-1.5">
            {cloners.map(([id, agent]) => (
              <WorkerCard key={id} name={agent.name} praise={0} criticism={0} conflict={0} status={agent.status} />
            ))}
          </div>
        </>
      )}

      {/* Verdict */}
      {lastVerdict && (
        <div className="px-3 py-2 border-y border-background-border">
          <span className="text-xs font-medium text-neutral-400 uppercase tracking-wider">Latest Verdict</span>
          <div className={`mt-1.5 text-sm font-medium ${lastVerdict.passed ? "text-status-success" : "text-status-danger"}`}>
            {lastVerdict.passed ? "PASS" : "FAIL"} {lastVerdict.approval}/{lastVerdict.total}
          </div>
          {lastVerdict.findings && lastVerdict.findings.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {lastVerdict.findings.slice(0, 3).map((f, i) => (
                <div key={i} className="text-xs text-neutral-500 truncate">{f}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* File Conflicts */}
      {conflicts.length > 0 && (
        <div className="px-3 py-2 border-t border-background-border">
          <span className="text-xs font-medium text-neutral-400 uppercase tracking-wider flex items-center gap-1">
            <FileWarning size={11} /> File Conflicts
          </span>
          <div className="mt-1.5 space-y-1">
            {conflicts.slice(-5).map((c, i) => (
              <div key={i} className="text-xs text-neutral-500 flex items-center gap-1">
                <span className="text-status-danger">{c.severity === "overlap" ? "!" : "*"}</span>
                <span className="truncate">{c.file}</span>
                <span className="text-neutral-600">{c.writers?.join(",")}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
