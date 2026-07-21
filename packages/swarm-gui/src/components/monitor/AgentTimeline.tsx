/**
 * AgentTimeline — horizontal swimlane timeline of agent tool calls.
 *
 * Each agent gets a swimlane. Tool calls are shown as colored blocks
 * positioned relative to the overall run duration.
 * Built from swarm-store.toolCalls data populated by SSE tool_call events.
 */

import { useMemo } from "react";
import { useSwarmStore } from "../../stores/swarm-store";
import { Clock, Wrench } from "lucide-react";
import { EmptyState } from "../shared/EmptyState";

interface ToolCallEntry {
  ts: number;
  tool: string;
  file?: string;
  duration?: number;
  tokens?: number;
  exitCode?: number;
  agent: string;
}

const TOOL_COLORS: Record<string, string> = {
  read: "bg-blue-500/60",
  write_file: "bg-emerald-500/60",
  edit: "bg-amber-500/60",
  bash: "bg-purple-500/60",
  grep: "bg-cyan-500/60",
  glob: "bg-pink-500/60",
  round_complete: "bg-background-overlay/60",
};

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function AgentTimeline() {
  const toolCalls = useSwarmStore((s) => s.toolCalls);
  const swarmState = useSwarmStore((s) => s.swarmState);

  const { agentNames, allCalls } = useMemo(() => {
    const names = Array.from(toolCalls.keys());
    const calls: ToolCallEntry[] = [];
    for (const agent of names) {
      const agentCalls = toolCalls.get(agent) ?? [];
      for (const c of agentCalls) {
        calls.push({ ...c, agent });
      }
    }
    calls.sort((a, b) => a.ts - b.ts);
    return { agentNames: names, allCalls: calls };
  }, [toolCalls]);

  if (allCalls.length === 0) {
    return (
      <EmptyState
        icon={<Wrench size={24} />}
        title="No tool calls yet"
        description={
          swarmState?.status === "running"
            ? "Waiting for worker activity..."
            : "Start a swarm run to see the timeline."
        }
      />
    );
  }

  const startTs = allCalls[0].ts;
  const endTs = allCalls[allCalls.length - 1].ts;
  const totalMs = Math.max(endTs - startTs, 1);

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2 border-b border-border flex items-center gap-2 bg-background-card">
        <Clock size={14} className="text-fg-muted" />
        <span className="text-xs font-medium text-fg-muted">Agent Timeline</span>
        <span className="text-xs text-fg-faint tabular-nums">
          {allCalls.length} calls · {formatMs(totalMs)}
        </span>
      </div>

      {/* Swimlanes */}
      <div className="flex-1 overflow-auto p-3 space-y-2">
        {agentNames.map((agentName) => {
          const calls = (toolCalls.get(agentName) ?? []) as ToolCallEntry[];
          return (
            <div key={agentName} className="flex items-center gap-2">
              <div className="w-24 flex-shrink-0 text-xs font-mono text-fg-muted truncate" title={agentName}>
                {agentName}
              </div>
              <div className="flex-1 h-5 bg-background-elevated rounded-sm relative overflow-hidden">
                {calls.map((call, i) => {
                  const left = ((call.ts - startTs) / totalMs) * 100;
                  const width = Math.max(((call.duration ?? 100) / totalMs) * 100, 2);
                  const color = TOOL_COLORS[call.tool] ?? "bg-background-overlay/40";
                  return (
                    <div
                      key={`${agentName}-${i}`}
                      className={`absolute top-0.5 bottom-0.5 rounded-sm ${color} cursor-default`}
                      style={{
                        left: `${left}%`,
                        width: `${Math.min(width, 100 - left)}%`,
                      }}
                      title={`${call.tool}${call.file ? `: ${call.file}` : ""}${call.duration ? ` (${formatMs(call.duration)})` : ""}`}
                    />
                  );
                })}
              </div>
              <span className="w-8 text-right text-xs text-fg-faint tabular-nums">{calls.length}</span>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="px-4 py-2 border-t border-border flex items-center gap-3 flex-wrap bg-background-card">
        {Object.entries(TOOL_COLORS).map(([tool, color]) => (
          <div key={tool} className="flex items-center gap-1">
            <div className={`w-2.5 h-2.5 rounded-sm ${color}`} />
            <span className="text-[10px] text-fg-faint">{tool}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
