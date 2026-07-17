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
  reflection: "text-purple-400",
};

export default function AfterLoopPanel() {
  const afterLoopResult = useSwarmStore((s) => s.afterLoopResult);
  const [collapsed, setCollapsed] = useState(false);
  const [stats, setStats] = useState<ExperienceStats | null>(null);

  useEffect(() => {
    api.getExperienceStats().then(setStats).catch(() => {});
  }, [afterLoopResult]);

  if (!afterLoopResult) return null;

  const { status, iterations, lessons, reflection, stats: runStats, summaryMarkdown } = afterLoopResult;
  const safeLessons = lessons ?? [];
  const safeRunStats = runStats ?? { workerCount: 0, clonerCount: 0, clonerApprovalRatio: 0 };
  const statusIcon = status === "completed" ? CheckCircle : status === "escalated" ? AlertTriangle : AlertOctagon;
  const StatusIcon = statusIcon;
  const statusColor = status === "completed" ? "text-status-success" : status === "escalated" ? "text-status-warning" : "text-status-danger";

  // Group lessons by type
  const grouped = safeLessons.reduce<Record<string, typeof safeLessons>>((acc, lesson) => {
    (acc[lesson.type] ??= []).push(lesson);
    return acc;
  }, {});

  return (
    <div className="border-t border-background-border">
      {/* Header */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-background-elevated/50 transition-colors"
      >
        <div className="flex items-center gap-1.5">
          {collapsed ? <ChevronRight size={14} className="text-neutral-500" /> : <ChevronDown size={14} className="text-neutral-500" />}
          <Brain size={14} className="text-purple-400" />
          <span className="text-xs font-medium text-neutral-400 uppercase tracking-wider">After Loop</span>
          <span className={`text-xs ${statusColor}`}>{status}</span>
        </div>
        <span className="text-xs text-neutral-600">{iterations} iter</span>
      </button>

      {!collapsed && (
        <div className="px-3 pb-3 space-y-3">
          {/* Run stats row */}
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="bg-background-elevated rounded px-2 py-1.5 text-center">
              <div className="text-neutral-600">Workers</div>
              <div className="text-neutral-200 font-mono">{safeRunStats.workerCount}</div>
            </div>
            <div className="bg-background-elevated rounded px-2 py-1.5 text-center">
              <div className="text-neutral-600">Cloners</div>
              <div className="text-neutral-200 font-mono">{safeRunStats.clonerCount}</div>
            </div>
            <div className="bg-background-elevated rounded px-2 py-1.5 text-center">
              <div className="text-neutral-600">Approval</div>
              <div className="text-neutral-200 font-mono">{Math.round((safeRunStats.clonerApprovalRatio ?? 0) * 100)}%</div>
            </div>
          </div>

          {/* Deep Reflection */}
          {reflection && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-purple-400">
                <Brain size={12} />
                <span>Deep Reflection</span>
                <span className="text-neutral-600 ml-auto">conf: {Math.round(reflection.confidence * 100)}%</span>
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
              <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-400">
                <BookOpen size={12} />
                <span>Lessons ({safeLessons.length})</span>
              </div>
              {Object.entries(grouped).map(([type, typeLessons]) => {
                const Icon = LESSON_ICONS[type] ?? Lightbulb;
                const color = LESSON_COLORS[type] ?? "text-neutral-400";
                return (
                  <div key={type} className="space-y-1">
                    <div className={`flex items-center gap-1 text-xs ${color}`}>
                      <Icon size={11} />
                      <span className="capitalize">{type}</span>
                      <span className="text-neutral-600">({typeLessons.length})</span>
                    </div>
                    {typeLessons.slice(0, 3).map((lesson, i) => (
                      <div key={i} className="text-xs text-neutral-500 pl-4 truncate" title={lesson.detail}>
                        {lesson.summary}
                      </div>
                    ))}
                    {typeLessons.length > 3 && (
                      <div className="text-xs text-neutral-600 pl-4">+{typeLessons.length - 3} more</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Experience Store Stats */}
          {stats && stats.totalRuns > 0 && (
            <div className="space-y-1.5 pt-1 border-t border-background-border">
              <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-400">
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
            <summary className="cursor-pointer text-neutral-500 hover:text-neutral-300 transition-colors">
              View full summary
            </summary>
            <div className="markdown-body mt-2 max-h-60 overflow-y-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{summaryMarkdown}</ReactMarkdown>
            </div>
          </details>
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
        <div key={i} className="text-xs text-neutral-500 pl-4">{item}</div>
      ))}
      {items.length > 3 && (
        <div className="text-xs text-neutral-600 pl-4">+{items.length - 3} more</div>
      )}
    </div>
  );
}

function StatItem({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-background-elevated rounded px-2 py-1 text-center">
      <span className="text-neutral-600">{label}: </span>
      <span className="text-neutral-200 font-mono">{value}</span>
    </div>
  );
}
