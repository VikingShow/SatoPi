import { useState, useMemo } from "react";
import { Crown, FileWarning, Bot, ListTodo, FileText, Brain, TrendingUp, TrendingDown, ChevronDown, ChevronRight } from "lucide-react";
import { useSwarmStore } from "../../stores/swarm-store";
import PlanViewer from "./PlanViewer";
import TodoList from "./TodoList";
import AfterLoopPanel from "./AfterLoopPanel";
import { Button } from "../ui/button";

function WorkerCard({ name, praise, criticism, conflict, status, role }: {
  name: string; praise: number; criticism: number; conflict: number;
  status: string; role?: string;
}) {
  const score = praise - criticism - conflict;
  const scoreColor = score > 0 ? "text-success" : score < 0 ? "text-danger" : "text-muted-foreground";
  const statusDot = status === "completed" ? "bg-success" : status === "running" ? "bg-warning" : status === "failed" ? "bg-danger" : "bg-background-overlay";

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
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground/50">
        <span>{praise}✓</span>
        <span>{criticism}✗</span>
        <span>{conflict}⚡</span>
      </div>
    </div>
  );
}

// ── Scaling events (collapsible) ──────────────────────────────────────

function ScalingEvents() {
  const activities = useSwarmStore((s) => s.activities);
  const [collapsed, setCollapsed] = useState(true);
  const scalingEvents = useMemo(
    () => activities.filter((a) => a.type === "scaling").slice(-10).reverse(),
    [activities],
  );

  if (scalingEvents.length === 0) return null;

  return (
    <div className="px-3 py-2 border-t border-border bg-background-elevated/20">
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-1 text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider hover:text-muted-foreground"
      >
        {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
        Scaling ({scalingEvents.length})
      </Button>
      {!collapsed && (
        <div className="mt-1 space-y-0.5">
          {scalingEvents.map((ev, i) => {
            const isAdd = ev.action === "add";
            return (
              <div key={i} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                {isAdd ? (
                  <TrendingUp size={10} className="text-status-success flex-shrink-0" />
                ) : (
                  <TrendingDown size={10} className="text-status-danger flex-shrink-0" />
                )}
                <span className="font-mono text-foreground/80">{ev.worker}</span>
                <span>{ev.reason ?? (isAdd ? "added" : "removed")}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type Tab = "agents" | "tasks" | "plan";

export default function ContextPanel() {
  const swarmState = useSwarmStore((s) => s.swarmState);
  const activities = useSwarmStore((s) => s.activities);
  const [tab, setTab] = useState<Tab>("agents");

  // Panel visibility MUST be decoupled from swarmState. Previously
  // `if (!swarmState) return null` bound the entire right-hand panel to a
  // non-null swarmState, so any transient null (new session, getState()
  // returning empty, a race during init) made the whole Agents/Tasks/Plan
  // panel vanish. We now always render the panel shell and derive data
  // defensively, showing an idle/empty state instead of disappearing.
  const agents = Object.entries(swarmState?.agents ?? {});
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
          <Button
            variant="ghost"
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 flex items-center justify-center gap-1 py-2 text-xs font-medium ${
              tab === t.id
                ? "text-primary border-b-2 border-primary"
                : "text-muted-foreground/50 hover:text-muted-foreground"
            }`}
          >
            {t.icon}
            {t.label}
          </Button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "agents" && (
        <div className="flex-1 overflow-y-auto">
          {/* Verdict summary (top of agents tab) */}
          {lastVerdict && (
            <div className="px-3 py-2 border-b border-border bg-background-elevated/30">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">Verdict</span>
                <span className={`text-xs font-bold ${lastVerdict.passed ? "text-success" : "text-danger"}`}>
                  {lastVerdict.passed ? "PASS" : "FAIL"} {lastVerdict.approval}/{lastVerdict.total}
                </span>
              </div>
              {lastVerdict.findings && lastVerdict.findings.length > 0 && (
                <div className="mt-1 text-[10px] text-muted-foreground/50 truncate">{lastVerdict.findings[0]}</div>
              )}
            </div>
          )}

          {/* Workers */}
          <div className="px-3 py-2 border-b border-border">
            <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider">Agents ({workers.length})</span>
          </div>
          {workers.length > 0 ? (
            <div className="p-2 space-y-1">
              {workers.map(([id, agent]) => (
                <WorkerCard key={id} name={agent.name} praise={agent.praiseCount} criticism={agent.criticismCount} conflict={agent.conflictCount} status={agent.status} role={agent.role} />
              ))}
            </div>
          ) : (
            <div className="px-3 py-6 flex flex-col items-center gap-1.5 text-center">
              <Bot size={18} className="text-muted-foreground/50/60" />
              <span className="text-[11px] text-muted-foreground/50">No active agents yet</span>
              <span className="text-[10px] text-muted-foreground/50/70">Agents appear here once the swarm starts working.</span>
            </div>
          )}

          {/* Reviewers */}
          {reviewers.length > 0 && (
            <>
              <div className="px-3 py-2 border-b border-border border-t bg-background-elevated/20">
                <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider">Reviewers ({reviewers.length})</span>
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
              <span className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider flex items-center gap-1">
                <FileWarning size={10} /> Conflicts
              </span>
              <div className="mt-1 space-y-0.5">
                {conflicts.slice(-3).map((c, i) => (
                  <div key={i} className="text-[10px] text-muted-foreground flex items-center gap-1 group">
                    <span className="text-danger">{c.severity === "overlap" ? "!" : "*"}</span>
                    <span className="truncate flex-1">{c.file}</span>
                    <span className="text-muted-foreground/50">{c.writers?.join(",")}</span>
                    {/* P2-9: View diff button — opens CodeEditor DiffViewer in a dialog */}
                    <Button
                      variant="link"
                      size="xs"
                      onClick={() => {
                        const original = (c as any).original ?? "";
                        const modified = (c as any).modified ?? c.body ?? "";
                        if (original || modified) {
                          // Open inline diff view below
                          const detailEl = document.getElementById(`diff-${i}`);
                          if (detailEl) detailEl.classList.toggle("hidden");
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 text-[9px] text-primary/70 hover:text-primary"
                      title="View diff"
                    >
                      Diff
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Worker scaling events */}
          <ScalingEvents />

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
