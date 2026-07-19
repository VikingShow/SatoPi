import { useState } from "react";
import { Crown, FileWarning, Bot, ListTodo, FileText, Brain } from "lucide-react";
import { useSwarmStore } from "../../stores/swarm-store";
import PlanViewer from "./PlanViewer";
import TodoList from "./TodoList";
import AfterLoopPanel from "./AfterLoopPanel";

function WorkerCard({ name, praise, criticism, conflict, status, role }: {
  name: string; praise: number; criticism: number; conflict: number;
  status: string; role?: string;
}) {
  const score = praise - criticism - conflict;
  const scoreColor = score > 0 ? "text-success" : score < 0 ? "text-danger" : "text-fg-muted";
  const statusDot = status === "completed" ? "bg-success" : status === "running" ? "bg-warning" : status === "failed" ? "bg-danger" : "bg-neutral-600";

  return (
    <div className="bg-background-elevated rounded px-2.5 py-2 border border-border">
      <div className="flex items-center justify-between mb-0.5">
        <div className="flex items-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
          <span className="text-xs font-medium text-foreground">{name}</span>
          {role === "reviewer" && <Crown size={11} className="text-warning" />}
        </div>
        <span className={`text-xs font-mono ${scoreColor}`}>{score > 0 ? "+" : ""}{score}</span>
      </div>
      <div className="flex items-center gap-2 text-[10px] text-fg-faint">
        <span>{praise}✓</span>
        <span>{criticism}✗</span>
        <span>{conflict}⚡</span>
      </div>
    </div>
  );
}

type Tab = "agents" | "tasks" | "plan";

export default function ContextPanel() {
  const swarmState = useSwarmStore((s) => s.swarmState);
  const activities = useSwarmStore((s) => s.activities);
  const [tab, setTab] = useState<Tab>("agents");

  if (!swarmState) return null;

  const agents = Object.entries(swarmState.agents);
  const workers = agents.filter(([_, a]) => !a.name.startsWith("cloner"));
  const reviewers = agents.filter(([_, a]) => a.name.startsWith("cloner"));
  const lastVerdict = [...activities].reverse().find((a) => a.type === "verdict");
  const conflicts = activities.filter((a) => a.type === "conflict");

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "agents", label: "Agents", icon: <Bot size={13} /> },
    { id: "tasks", label: "Tasks", icon: <ListTodo size={13} /> },
    { id: "plan", label: "Plan", icon: <FileText size={13} /> },
  ];

  return (
    <div className="w-64 flex flex-col border-l border-border bg-background-card overflow-y-auto">
      {/* Tab bar */}
      <div className="flex border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 flex items-center justify-center gap-1 py-2 text-xs font-medium transition-colors cursor-pointer ${
              tab === t.id
                ? "text-primary border-b-2 border-primary"
                : "text-fg-faint hover:text-fg-muted"
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "agents" && (
        <div className="flex-1 overflow-y-auto">
          {/* Verdict summary (top of agents tab) */}
          {lastVerdict && (
            <div className="px-3 py-2 border-b border-border bg-background-elevated/30">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-fg-faint">Verdict</span>
                <span className={`text-xs font-bold ${lastVerdict.passed ? "text-success" : "text-danger"}`}>
                  {lastVerdict.passed ? "PASS" : "FAIL"} {lastVerdict.approval}/{lastVerdict.total}
                </span>
              </div>
              {lastVerdict.findings && lastVerdict.findings.length > 0 && (
                <div className="mt-1 text-[10px] text-fg-faint truncate">{lastVerdict.findings[0]}</div>
              )}
            </div>
          )}

          {/* Workers */}
          <div className="px-3 py-2 border-b border-border">
            <span className="text-[10px] font-medium text-fg-faint uppercase tracking-wider">Agents ({workers.length})</span>
          </div>
          <div className="p-2 space-y-1">
            {workers.map(([id, agent]) => (
              <WorkerCard key={id} name={agent.name} praise={agent.praiseCount} criticism={agent.criticismCount} conflict={agent.conflictCount} status={agent.status} role={agent.role} />
            ))}
          </div>

          {/* Reviewers */}
          {reviewers.length > 0 && (
            <>
              <div className="px-3 py-2 border-b border-border border-t bg-background-elevated/20">
                <span className="text-[10px] font-medium text-fg-faint uppercase tracking-wider">Reviewers ({reviewers.length})</span>
              </div>
              <div className="p-2 space-y-1">
                {reviewers.map(([id, agent]) => (
                  <WorkerCard key={id} name={agent.name} praise={0} criticism={0} conflict={0} status={agent.status} />
                ))}
              </div>
            </>
          )}

          {/* File Conflicts */}
          {conflicts.length > 0 && (
            <div className="px-3 py-2 border-t border-border">
              <span className="text-[10px] font-medium text-fg-faint uppercase tracking-wider flex items-center gap-1">
                <FileWarning size={10} /> Conflicts
              </span>
              <div className="mt-1 space-y-0.5">
                {conflicts.slice(-3).map((c, i) => (
                  <div key={i} className="text-[10px] text-fg-muted flex items-center gap-1 group">
                    <span className="text-danger">{c.severity === "overlap" ? "!" : "*"}</span>
                    <span className="truncate flex-1">{c.file}</span>
                    <span className="text-fg-faint">{c.writers?.join(",")}</span>
                    {/* P2-9: View diff button — opens CodeEditor DiffViewer in a dialog */}
                    <button
                      onClick={() => {
                        const original = (c as any).original ?? "";
                        const modified = (c as any).modified ?? c.body ?? "";
                        if (original || modified) {
                          // Open inline diff view below
                          const detailEl = document.getElementById(`diff-${i}`);
                          if (detailEl) detailEl.classList.toggle("hidden");
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 text-[9px] text-primary/70 hover:text-primary cursor-pointer transition-opacity"
                      title="View diff"
                    >
                      Diff
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* After Loop results */}
          <AfterLoopPanel />
        </div>
      )}

      {tab === "tasks" && <TodoList />}

      {tab === "plan" && (
        <div className="flex-1 overflow-y-auto">
          <PlanViewer />
        </div>
      )}
    </div>
  );
}
