/**
 * ScalingHistory — worker count timeline + event log.
 *
 * Charts the number of active workers over time using the scaling events
 * captured by the swarm store. Each event (add/remove) is shown as a
 * timeline entry with the reason.
 */
import { useMemo } from "react";
import { TrendingUp, TrendingDown, GitBranch } from "lucide-react";
import { useSwarmStore } from "../../stores/swarm-store";
import { EmptyState } from "../shared/EmptyState";

interface ScalingPoint {
  ts: number;
  count: number;
  events: Array<{ worker: string; action: string; reason?: string }>;
}

export default function ScalingHistory() {
  const activities = useSwarmStore((s) => s.activities);
  const swarmState = useSwarmStore((s) => s.swarmState);

  const { points, maxCount } = useMemo(() => {
    const scalingEvents = activities.filter((a) => a.type === "scaling");
    if (scalingEvents.length === 0) return { points: [], maxCount: 0 };

    // Start from initial worker count (or 0 if unknown)
    let currentCount = Object.keys(swarmState?.agents ?? {}).filter(
      (k) => k.startsWith("worker"),
    ).length || 0;

    const pts: ScalingPoint[] = [];
    // Group events by timestamp (events within 500ms are batched)
    const sorted = [...scalingEvents].sort((a, b) => a.ts - b.ts);
    let batch: ScalingPoint | null = null;

    for (const ev of sorted) {
      const action = ev.action ?? "add";
      if (!batch || ev.ts - batch.ts > 500) {
        if (batch) {
          currentCount += batch.events.filter((e) => e.action === "add").length;
          currentCount -= batch.events.filter((e) => e.action === "remove").length;
          batch.count = currentCount;
        }
        batch = { ts: ev.ts, count: currentCount, events: [] };
        pts.push(batch);
      }
      batch.events.push({ worker: ev.worker ?? "?", action, reason: ev.reason });
    }
    if (batch) {
      currentCount += batch.events.filter((e) => e.action === "add").length;
      currentCount -= batch.events.filter((e) => e.action === "remove").length;
      batch.count = currentCount;
    }

    const max = Math.max(...pts.map((p) => p.count), 1);
    return { points: pts, maxCount: max };
  }, [activities, swarmState]);

  if (points.length === 0) {
    return (
      <EmptyState
        icon={<GitBranch size={24} />}
        title="No scaling events"
        description="Worker count changes (add/remove) will appear here during loop execution."
      />
    );
  }

  const startTs = points[0].ts;
  const endTs = points[points.length - 1].ts;
  const totalMs = Math.max(endTs - startTs, 1);

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2 border-b border-border flex items-center gap-2 bg-background-card">
        <GitBranch size={14} className="text-fg-muted" />
        <span className="text-xs font-medium text-fg-muted">Scaling History</span>
        <span className="text-xs text-fg-faint tabular-nums">
          {points.length} events · peak {maxCount} workers
        </span>
      </div>

      {/* Mini chart */}
      <div className="px-4 py-3 border-b border-border/50">
        <div className="flex items-end gap-px h-16">
          {points.map((pt, i) => {
            const heightPct = maxCount > 0 ? (pt.count / maxCount) * 100 : 0;
            return (
              <div
                key={i}
                className="flex-1 min-w-[3px] relative group"
                title={`${new Date(pt.ts).toLocaleTimeString()}: ${pt.count} workers`}
              >
                <div
                  className="w-full bg-primary/60 rounded-t-sm transition-all"
                  style={{ height: `${Math.max(heightPct, 4)}%` }}
                />
                {/* Tooltip on hover */}
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10">
                  <div className="bg-background-card border border-border rounded px-2 py-1 text-[10px] text-fg-muted whitespace-nowrap shadow-lg">
                    {pt.count} workers
                    <br />
                    {new Date(pt.ts).toLocaleTimeString()}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {/* Y-axis labels */}
        <div className="flex justify-between mt-1 text-[9px] text-fg-faint">
          <span>{maxCount}</span>
          <span>workers</span>
          <span>0</span>
        </div>
        {/* X-axis time range */}
        <div className="flex justify-between text-[9px] text-fg-faint mt-0.5">
          <span>{new Date(startTs).toLocaleTimeString()}</span>
          <span>{new Date(endTs).toLocaleTimeString()}</span>
        </div>
      </div>

      {/* Event log */}
      <div className="flex-1 overflow-auto">
        {points.map((pt, i) => (
          <div key={i} className="px-4 py-1.5 border-b border-border/30 hover:bg-background-elevated/20">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-fg-faint font-mono w-16 tabular-nums">
                {new Date(pt.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
              <span className="text-xs font-mono text-fg-muted font-medium">
                {pt.count} workers
              </span>
            </div>
            <div className="mt-0.5 space-y-0.5 ml-18">
              {pt.events.map((ev, j) => (
                <div key={j} className="flex items-center gap-1.5 text-[10px]">
                  {ev.action === "add" ? (
                    <TrendingUp size={10} className="text-status-success flex-shrink-0" />
                  ) : (
                    <TrendingDown size={10} className="text-status-danger flex-shrink-0" />
                  )}
                  <span className="font-mono text-foreground/80">{ev.worker}</span>
                  <span className="text-fg-faint">{ev.action === "add" ? "added" : "removed"}</span>
                  {ev.reason && (
                    <span className="text-fg-faint/70 truncate">— {ev.reason}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
