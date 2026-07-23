import { useState, useEffect } from "react";
import { Swords, Check, CheckCircle2 } from "lucide-react";
import { Button } from "../ui/button";
import type { Chapter } from "../../lib/types";

export interface ActionBarProps {
  phase: Chapter;
  recommendedAgents?: number;
  estimatedAgentHours?: number;
  onConfirm: (agentCount: number, reviewerCount: number) => void;
  onDebate: () => void;
}

export function ActionBar({
  phase,
  recommendedAgents,
  estimatedAgentHours,
  onConfirm,
  onDebate,
}: ActionBarProps) {
  const [agentCount, setAgentCount] = useState(recommendedAgents ?? 3);
  const [reviewerCount, setReviewerCount] = useState(2);

  useEffect(() => {
    if (recommendedAgents != null) setAgentCount(recommendedAgents);
  }, [recommendedAgents]);

  const isDebateDone = phase === "script-confirm";

  return (
    <div className="border-t border-purple-800/40 px-4 py-2.5 bg-linear-to-r from-purple-950/30 to-blue-950/30">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-xs font-medium text-purple-300 shrink-0">
          <CheckCircle2 size={12} />
          {isDebateDone ? "Debate complete - plan refined" : "Plan draft ready"}
        </span>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            Agents
            <input
              type="number" min={1} max={20}
              value={agentCount}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v > 0) setAgentCount(v);
              }}
              className="w-12 h-6 px-1 text-xs text-center bg-gray-900/60 border border-gray-700 rounded
                         text-gray-200 focus:outline-none focus:border-purple-500/60
                         [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </label>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            Reviewers
            <input
              type="number" min={1} max={20}
              value={reviewerCount}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v > 0) setReviewerCount(v);
              }}
              className="w-12 h-6 px-1 text-xs text-center bg-gray-900/60 border border-gray-700 rounded
                         text-gray-200 focus:outline-none focus:border-purple-500/60
                         [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          </label>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="default"
            size="xs"
            onClick={onDebate}
            className="bg-status-accent hover:bg-status-accent/80"
          >
            <Swords size={12} />
            {isDebateDone ? "Run Debate Again" : "Run Debate"}
          </Button>
          <Button
            variant="default"
            size="xs"
            onClick={() => onConfirm(agentCount, reviewerCount)}
            className="bg-status-success hover:bg-status-success/80"
          >
            <Check size={12} />
            Confirm & Start
          </Button>
        </div>
      </div>
    </div>
  );
}
