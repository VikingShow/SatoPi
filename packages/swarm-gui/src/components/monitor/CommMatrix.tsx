/**
 * CommMatrix — agent-to-agent communication frequency heatmap.
 *
 * X-axis = sender, Y-axis = receiver. Color intensity = message count.
 * Built from broadcast + steering events in the activity log.
 */
import { useMemo } from "react";
import { MessageSquare, ArrowRightLeft } from "lucide-react";
import { useSwarmStore } from "../../stores/swarm-store";
import { EmptyState } from "../shared/EmptyState";

export default function CommMatrix() {
  const activities = useSwarmStore((s) => s.activities);

  const { agents, matrix, maxCount } = useMemo(() => {
    // Collect all unique agent names from broadcast/steering events
    const agentSet = new Set<string>();
    const pairCounts = new Map<string, number>();

    for (const a of activities) {
      if (a.type !== "broadcast" && a.type !== "steering") continue;
      const from = a.from;
      const to = a.to === "all" ? "all" : a.to;
      if (!from || !to) continue;
      agentSet.add(from);
      if (to !== "all") agentSet.add(to);

      const key = `${from}→${to}`;
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }

    const agents = [...agentSet].sort();
    // Build matrix: rows=senders, cols=receivers
    const matrix: number[][] = agents.map((from) =>
      agents.map((to) => pairCounts.get(`${from}→${to}`) ?? 0),
    );
    const max = Math.max(1, ...matrix.flat());
    return { agents, matrix, maxCount: max };
  }, [activities]);

  if (agents.length === 0) {
    return (
      <EmptyState
        icon={<ArrowRightLeft size={24} />}
        title="No communication data"
        description="Agent-to-agent messages will be tracked here once the swarm starts."
      />
    );
  }

  const cellSize = Math.max(28, Math.min(48, Math.floor(320 / agents.length)));
  const totalPairs = matrix.flat().reduce((a, b) => a + b, 0);

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2 border-b border-border flex items-center gap-2 bg-background-card">
        <ArrowRightLeft size={14} className="text-fg-muted" />
        <span className="text-xs font-medium text-fg-muted">Communication Matrix</span>
        <span className="text-xs text-fg-faint tabular-nums">
          {agents.length} agents · {totalPairs} messages
        </span>
      </div>

      {/* Legend */}
      <div className="px-4 py-1.5 border-b border-border/50 flex items-center gap-2 text-[10px] text-fg-faint">
        <span>← sender</span>
        <div className="flex items-center gap-0.5">
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <div
              key={v}
              className="w-3 h-3 rounded-sm"
              style={{ backgroundColor: `rgba(59,130,246,${0.1 + v * 0.7})` }}
            />
          ))}
        </div>
        <span>receiver →</span>
      </div>

      {/* Heatmap grid */}
      <div className="flex-1 overflow-auto p-4">
        <div className="inline-block">
          {/* Column headers (receivers) */}
          <div className="flex" style={{ marginLeft: `${Math.max(80, agents.length * 8)}px` }}>
            {agents.map((agent) => (
              <div
                key={agent}
                className="flex items-end justify-center pb-1"
                style={{ width: cellSize, height: 80 }}
              >
                <span
                  className="text-[9px] text-fg-faint font-mono -rotate-45 origin-bottom-left whitespace-nowrap"
                  style={{ transform: "rotate(-60deg)", transformOrigin: "bottom left" }}
                >
                  {agent.length > 10 ? agent.slice(0, 9) + "…" : agent}
                </span>
              </div>
            ))}
          </div>

          {/* Rows */}
          {agents.map((from, ri) => (
            <div key={from} className="flex items-center">
              {/* Row label (sender) */}
              <div
                className="flex items-center justify-end pr-2 flex-shrink-0"
                style={{ width: Math.max(80, agents.length * 8) }}
              >
                <span className="text-[10px] text-fg-faint font-mono truncate max-w-full" title={from}>
                  {from.length > 12 ? from.slice(0, 11) + "…" : from}
                </span>
              </div>
              {/* Cells */}
              {agents.map((to, ci) => {
                const count = matrix[ri][ci];
                const intensity = count > 0 ? 0.1 + (count / maxCount) * 0.7 : 0.02;
                return (
                  <div
                    key={to}
                    className="flex items-center justify-center border border-border/20 rounded-sm cursor-default"
                    style={{
                      width: cellSize,
                      height: cellSize,
                      backgroundColor: count > 0
                        ? `rgba(59,130,246,${intensity})`
                        : "rgba(255,255,255,0.02)",
                    }}
                    title={count > 0 ? `${from} → ${to}: ${count} msg${count !== 1 ? "s" : ""}` : `${from} → ${to}: —`}
                  >
                    {count > 0 && (
                      <span
                        className="text-[9px] font-mono tabular-nums"
                        style={{ color: intensity > 0.4 ? "#fff" : "rgba(148,163,184,0.8)" }}
                      >
                        {count > 99 ? "…" : count}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Top pairs summary */}
      <div className="px-4 py-2 border-t border-border flex items-center gap-3 flex-wrap text-[10px] bg-background-card">
        <MessageSquare size={12} className="text-fg-muted" />
        {agents.length > 0 && (() => {
          const pairs = Array.from(
            (() => {
              const m = new Map<string, number>();
              for (let ri = 0; ri < agents.length; ri++) {
                for (let ci = 0; ci < agents.length; ci++) {
                  if (matrix[ri][ci] > 0) m.set(`${agents[ri]}→${agents[ci]}`, matrix[ri][ci]);
                }
              }
              return m;
            })(),
          ).sort((a, b) => b[1] - a[1]).slice(0, 5);
          return pairs.map(([pair, count]) => (
            <span key={pair} className="text-fg-faint">
              <span className="text-fg-muted font-mono">{pair}</span>{" "}
              <span className="text-primary">{count}</span>
            </span>
          ));
        })()}
      </div>
    </div>
  );
}
