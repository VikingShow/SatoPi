/**
 * AgentSelector — dropdown for selecting an agent during the Script phase.
 *
 * Shows all available agents with their profiles, highlighting the recommended one.
 * Falls back to highest credit score when no planner-optimized agent is found.
 */
import { useState, useEffect } from "react";
import { User, Sparkles, ChevronDown } from "lucide-react";
import { api } from "../../lib/api-client";
import type { AgentSummary } from "../../lib/types";

interface Props {
  onSelect: (agentId: string) => void;
  disabled?: boolean;
}

export default function AgentSelector({ onSelect, disabled }: Props) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api.getScriptAgents().then((res) => {
      setAgents(res.agents);
      // Auto-select the first recommended agent
      const first = res.agents[0];
      if (first) {
        setSelected(first.profileId);
        onSelect(first.profileId);
      }
    }).catch(() => {
      // No agents available yet
    }).finally(() => setLoading(false));
  }, []);

  const selectedAgent = agents.find(a => a.profileId === selected);

  return (
    <div className="relative">
      <button
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled || loading}
        className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border bg-background-card hover:bg-background-hover transition-colors disabled:opacity-50"
      >
        <User size={14} className="text-fg-muted" />
        {loading ? (
          <span className="text-fg-faint">Loading agents...</span>
        ) : selectedAgent ? (
          <span className="flex items-center gap-1.5">
            {selectedAgent.name}
            {selectedAgent.recommended && (
              <Sparkles size={12} className="text-amber-400" title="Recommended" />
            )}
            <span className="text-fg-faint text-xs ml-1">
              score {selectedAgent.score}
            </span>
          </span>
        ) : (
          <span className="text-fg-faint">Select an agent</span>
        )}
        <ChevronDown size={12} className="text-fg-muted ml-1" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-1 w-72 max-h-60 overflow-y-auto rounded-lg border border-border bg-background-card shadow-lg z-20">
            {agents.map((agent) => (
              <button
                key={agent.profileId}
                onClick={() => {
                  setSelected(agent.profileId);
                  onSelect(agent.profileId);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-background-hover transition-colors flex items-center justify-between ${
                  selected === agent.profileId ? "bg-primary/10" : ""
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="truncate font-medium">{agent.name}</span>
                  {agent.recommended && (
                    <Sparkles size={12} className="text-amber-400 flex-shrink-0" title="Recommended planner" />
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs text-fg-muted flex-shrink-0">
                  <span>{agent.score}</span>
                  <span className="opacity-50">{agent.totalTasks}t</span>
                </div>
              </button>
            ))}
            {agents.length === 0 && (
              <div className="px-3 py-4 text-sm text-fg-faint text-center">
                No agents available. Create agent profiles to get started.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
