import { useEffect, useState } from "react";
import { Clock, TrendingUp, AlertTriangle, Lightbulb } from "lucide-react";
import { api } from "../../lib/api-client";
import { useSessionStore } from "../../stores/session-store";
import type { ActivityEntry } from "../../lib/types";

export default function HistoryPage() {
  const runs = useSessionStore((s) => s.runs);
  const loadRuns = useSessionStore((s) => s.loadRuns);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);

  // Auto-refresh run list every 10s (same as SessionSwitcher)
  useEffect(() => {
    loadRuns();
    const id = setInterval(() => loadRuns(), 10_000);
    return () => clearInterval(id);
  }, [loadRuns]);

  useEffect(() => {
    if (selectedRun) {
      // Global endpoint — fetches a specific historical run's activity
      api.getRunActivity(selectedRun).then(({ entries }) => {
        setEntries(entries as ActivityEntry[]);
      }).catch(() => {});
    } else {
      // Session-scoped — fetches the active session's current history
      api.getHistory().then((data) => {
        setEntries(data.entries as ActivityEntry[]);
      }).catch(() => {});
    }
  }, [selectedRun]);

  const verdicts = entries.filter((e) => e.type === "verdict");
  const conflicts = entries.filter((e) => e.type === "conflict");
  const broadcasts = entries.filter((e) => e.type === "broadcast" || e.type === "subgroup");
  const crashes = entries.filter((e) => e.type === "crash");

  // Communication matrix
  const commMap = new Map<string, number>();
  for (const b of broadcasts) {
    const key = `${b.from}->${b.to ?? "all"}`;
    commMap.set(key, (commMap.get(key) ?? 0) + 1);
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Run list */}
      <div className="w-56 flex flex-col border-r border-border bg-background-card">
        <div className="px-3 py-2 border-b border-border">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Past Runs</span>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {runs.length === 0 && (
            <div className="px-3 py-4 text-xs text-muted-foreground/60">No past runs found.</div>
          )}
          {runs.map((run) => (
            <button
              key={run.name}
              onClick={() => setSelectedRun(run.name)}
              className={`w-full px-3 py-2 text-left transition-colors cursor-pointer ${
                selectedRun === run.name ? "bg-primary/10 text-foreground/90" : "text-muted-foreground hover:bg-background-elevated"
              }`}
            >
              <div className="text-sm truncate">{run.name}</div>
              {run.messageCount > 0 && (
                <div className="text-[10px] text-muted-foreground/60">{run.messageCount} msgs</div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Detail view */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Stats overview */}
        <div className="grid grid-cols-4 gap-3">
          <StatCard icon={<Clock size={14} />} label="Total Events" value={entries.length} color="text-status-info" />
          <StatCard icon={<TrendingUp size={14} />} label="Verdicts" value={verdicts.length} color="text-primary" />
          <StatCard icon={<AlertTriangle size={14} />} label="Conflicts" value={conflicts.length} color="text-status-danger" />
          <StatCard icon={<Lightbulb size={14} />} label="Messages" value={broadcasts.length} color="text-status-success" />
        </div>

        {/* Verdict cards */}
        {verdicts.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-foreground mb-2">Verdict History</h3>
            <div className="space-y-2">
              {verdicts.map((v, i) => (
                <div key={i} className="bg-background-card rounded-card border border-border p-3">
                  <div className="flex items-center gap-3 mb-1">
                    <span className={`text-sm font-medium ${v.passed ? "text-status-success" : "text-status-danger"}`}>
                      {v.passed ? "PASS" : "FAIL"}
                    </span>
                    <span className="text-xs text-muted-foreground">{v.approval}/{v.total} approved</span>
                    <span className="text-xs text-muted-foreground/60">{new Date(v.ts).toLocaleTimeString()}</span>
                  </div>
                  {v.findings && v.findings.length > 0 && (
                    <div className="space-y-0.5">
                      {v.findings.map((f, j) => (
                        <div key={j} className="text-xs text-muted-foreground">{f}</div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Communication matrix */}
        {commMap.size > 0 && (
          <div>
            <h3 className="text-sm font-medium text-foreground mb-2">Communication Map</h3>
            <div className="bg-background-card rounded-card border border-border p-3">
              <div className="space-y-1">
                {Array.from(commMap.entries()).sort((a, b) => b[1] - a[1]).map(([key, count]) => (
                  <div key={key} className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground w-32 truncate">{key}</span>
                    <div className="flex-1 h-1.5 bg-background-elevated rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary/60 rounded-full"
                        style={{ width: `${(count / Math.max(...commMap.values())) * 100}%` }}
                      />
                    </div>
                    <span className="text-muted-foreground w-6 text-right">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Crashes */}
        {crashes.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-foreground mb-2">Crashes</h3>
            <div className="space-y-1">
              {crashes.map((c, i) => (
                <div key={i} className="bg-status-danger/10 border border-status-danger/20 rounded-lg p-2 text-xs">
                  <span className="text-status-danger font-medium">{c.worker}</span>
                  <span className="text-muted-foreground ml-2">{c.error}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, color }: {
  icon: React.ReactNode; label: string; value: number; color: string;
}) {
  return (
    <div className="bg-background-card rounded-card border border-border p-3">
      <div className={`flex items-center gap-1.5 mb-1 ${color}`}>
        {icon}
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <div className="text-xl font-mono text-foreground">{value}</div>
    </div>
  );
}
