import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Brain, CheckCircle, AlertTriangle, AlertOctagon,
  Lightbulb, TrendingUp, ChevronDown, ChevronRight, BookOpen,
} from "lucide-react";
import { useSwarmStore } from "../../stores/swarm-store";
import { api } from "../../lib/api-client";
import type { ExperienceStats } from "../../lib/types";
import { Button } from "../ui/button";

const LESSON_ICONS: Record<string, typeof CheckCircle> = {
  success: CheckCircle,
  error: AlertOctagon,
  warning: AlertTriangle,
  insight: Lightbulb,
  pattern: TrendingUp,
  reflection: Brain,
};

const LESSON_COLORS: Record<string, string> = {
  success: "text-status-success",
  error: "text-status-danger",
  warning: "text-status-warning",
  insight: "text-primary",
  pattern: "text-primary",
  reflection: "text-status-accent",
};

export default function CurtainPanel() {
  const curtainResult = useSwarmStore((s) => s.curtainResult);
  const [collapsed, setCollapsed] = useState(false);
  const [stats, setStats] = useState<ExperienceStats | null>(null);

  useEffect(() => {
    api.getExperienceStats().then(setStats).catch(() => {});
  }, [curtainResult]);

  if (!curtainResult) return null;

  const { status, iterations, lessons, reflection, stats: runStats, summaryMarkdown } = curtainResult;
  const safeLessons = lessons ?? [];
  const safeRunStats = runStats ?? { agentCount: 0, reviewerCount: 0, reviewerApprovalRatio: 0 };
  const statusIcon = status === "completed" ? CheckCircle : status === "escalated" ? AlertTriangle : AlertOctagon;
  const StatusIcon = statusIcon;
  const statusColor = status === "completed" ? "text-status-success" : status === "escalated" ? "text-status-warning" : "text-status-danger";

  // Group lessons by type
  const grouped = safeLessons.reduce<Record<string, typeof safeLessons>>((acc, lesson) => {
    (acc[lesson.type] ??= []).push(lesson);
    return acc;
  }, {});

  return (
    <div className="border-t border-border">
      {/* Header */}
      <Button
        variant="ghost"
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-background-elevated/50"
      >
        <div className="flex items-center gap-1.5">
          {collapsed ? <ChevronRight size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
          <Brain size={14} className="text-status-accent" />
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">After Loop</span>
          <span className={`text-xs ${statusColor}`}>{status}</span>
        </div>
        <span className="text-xs text-muted-foreground/60">{iterations} iter</span>
      </Button>

      {!collapsed && (
        <div className="px-3 pb-3 space-y-3">
          {/* Run stats row */}
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="bg-background-elevated rounded px-2 py-1.5 text-center">
              <div className="text-muted-foreground/60">Workers</div>
              <div className="text-foreground font-mono">{safeRunStats.reviewerCount}</div>
            </div>
            <div className="bg-background-elevated rounded px-2 py-1.5 text-center">
              <div className="text-muted-foreground/60">Reviewers</div>
              <div className="text-foreground font-mono">{safeRunStats.reviewerCount}</div>
            </div>
            <div className="bg-background-elevated rounded px-2 py-1.5 text-center">
              <div className="text-muted-foreground/60">Approval</div>
              <div className="text-foreground font-mono">{Math.round((safeRunStats.reviewerApprovalRatio ?? 0) * 100)}%</div>
            </div>
          </div>

          {/* Deep Reflection */}
          {reflection && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-status-accent">
                <Brain size={12} />
                <span>Deep Reflection</span>
                <span className="text-muted-foreground/60 ml-auto">conf: {Math.round(reflection.confidence * 100)}%</span>
              </div>

              {reflection.rootCauses.length > 0 && (
                <ReflectionSection title="Root Causes" items={reflection.rootCauses} icon={AlertOctagon} color="text-status-danger" />
              )}
              {reflection.effectivePatterns.length > 0 && (
                <ReflectionSection title="Effective Patterns" items={reflection.effectivePatterns} icon={CheckCircle} color="text-status-success" />
              )}
              {reflection.structuralIssues.length > 0 && (
                <ReflectionSection title="Structural Issues" items={reflection.structuralIssues} icon={AlertTriangle} color="text-status-warning" />
              )}
              {reflection.recommendations.length > 0 && (
                <ReflectionSection title="Recommendations" items={reflection.recommendations} icon={Lightbulb} color="text-primary" />
              )}
            </div>
          )}

          {/* Extracted Lessons */}
          {safeLessons.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <BookOpen size={12} />
                <span>Lessons ({safeLessons.length})</span>
              </div>
              {Object.entries(grouped).map(([type, typeLessons]) => {
                const Icon = LESSON_ICONS[type] ?? Lightbulb;
                const color = LESSON_COLORS[type] ?? "text-muted-foreground";
                return (
                  <div key={type} className="space-y-1">
                    <div className={`flex items-center gap-1 text-xs ${color}`}>
                      <Icon size={11} />
                      <span className="capitalize">{type}</span>
                      <span className="text-muted-foreground/60">({typeLessons.length})</span>
                    </div>
                    {typeLessons.slice(0, 3).map((lesson, i) => (
                      <div key={i} className="text-xs text-muted-foreground pl-4 truncate" title={lesson.detail}>
                        {lesson.summary}
                      </div>
                    ))}
                    {typeLessons.length > 3 && (
                      <div className="text-xs text-muted-foreground/60 pl-4">+{typeLessons.length - 3} more</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Experience Store Stats */}
          {stats && stats.totalRuns > 0 && (
            <div className="space-y-1.5 pt-1 border-t border-border">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <TrendingUp size={12} />
                <span>Experience Store</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5 text-xs">
                <StatItem label="Total Runs" value={stats.totalRuns} />
                <StatItem label="Completion" value={`${Math.round(stats.completionRate * 100)}%`} />
                <StatItem label="Avg Iterations" value={stats.avgIterations} />
                <StatItem label="Avg Approval" value={`${Math.round(stats.avgApprovalRatio * 100)}%`} />
              </div>
            </div>
          )}

          {/* Full summary markdown (expandable) */}
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground/80 transition-colors">
              View full summary
            </summary>
            <div className="markdown-body mt-2 max-h-60 overflow-y-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{summaryMarkdown}</ReactMarkdown>
            </div>
          </details>

          {/* Applaud button */}
          <div className="pt-2">
            <ApplaudButton />
          </div>
        </div>
      )}
    </div>
  );
}

function ReflectionSection({ title, items, icon: Icon, color }: {
  title: string;
  items: string[];
  icon: typeof AlertOctagon;
  color: string;
}) {
  return (
    <div className="space-y-0.5">
      <div className={`flex items-center gap-1 text-xs ${color}`}>
        <Icon size={11} />
        <span>{title}</span>
      </div>
      {items.slice(0, 3).map((item, i) => (
        <div key={i} className="text-xs text-muted-foreground pl-4">{item}</div>
      ))}
      {items.length > 3 && (
        <div className="text-xs text-muted-foreground/60 pl-4">+{items.length - 3} more</div>
      )}
    </div>
  );
}

function StatItem({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-background-elevated rounded px-2 py-1 text-center">
      <span className="text-muted-foreground/60">{label}: </span>
      <span className="text-foreground font-mono">{value}</span>
    </div>
  );
}

function ApplaudButton() {
  const [applauded, setApplauded] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleApplaud() {
    setLoading(true);
    try {
      await api.applaud();
      setApplauded(true);
    } catch { /* best-effort */ }
    finally { setLoading(false); }
  }

  if (applauded) {
    return (
      <div className="text-center text-xs text-status-success py-1">
        Bravo! The curtain has fallen.
      </div>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleApplaud}
      disabled={loading}
      className="w-full text-xs gap-1.5 hover:bg-amber-500/10 hover:text-amber-400"
    >
      {loading ? "..." : "👏 Applaud"}
    </Button>
  );
}
