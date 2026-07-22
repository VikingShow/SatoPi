import { useSwarmStore } from "../../stores/swarm-store";
import { useThemeStore } from "../../stores/theme-store";
import { shallow } from "zustand/shallow";
import { Wifi, WifiOff, Loader2, GitGraph, MessageSquare, Users, Sun, Moon, Pause, Play, TrendingUp, TrendingDown, Zap, Brain, Clock, FileText, GitBranch, ArrowRightLeft } from "lucide-react";
import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import ChannelList from "./ChannelList";
import ChatView from "./ChatView";
import ContextPanel from "./ContextPanel";
import PhasePipeline from "./PhasePipeline";
import BlockerDialog from "./BlockerDialog";
import AgentTopology from "./AgentTopology";
import AgentTimeline from "./AgentTimeline";
import FileChangesPanel from "./FileChangesPanel";
import RoleBrowser from "./RoleBrowser";
import ScalingHistory from "./ScalingHistory";
import CommMatrix from "./CommMatrix";
import AfterLoopPanel from "./AfterLoopPanel";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function estimateCost(tokens: number): string {
  // Rough estimate: $3/M input tokens, $15/M output tokens → average ~$5/M
  const cost = (tokens / 1_000_000) * 5;
  if (cost >= 0.01) return `$${cost.toFixed(2)}`;
  return "<$0.01";
}

export default function MonitorPage() {
  const {
    swarmState, isRunning, isConnected, loopPhase,
    convergenceHistory, pauseRun, resumeRun, afterLoopResult,
  } = useSwarmStore((s) => ({
    swarmState: s.swarmState,
    isRunning: s.isRunning,
    isConnected: s.isConnected,
    loopPhase: s.loopPhase,
    convergenceHistory: s.convergenceHistory,
    afterLoopResult: s.afterLoopResult,
    pauseRun: s.pauseRun,
    resumeRun: s.resumeRun,
  }), shallow);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<"chat" | "timeline" | "files" | "topology" | "roles" | "scaling" | "commatrix" | "afterloop">("chat");

  const isActive = loopPhase === "running" || loopPhase === "blocked";

  // P2-5: Compute convergence trend from the last 3 values.
  const convergenceTrend = useMemo(() => {
    const h = convergenceHistory;
    if (h.length < 2) return null;
    const recent = h.slice(-3);
    const latest = recent[recent.length - 1].jaccard;
    const prev = recent[0].jaccard;
    return { latest, trend: latest >= prev ? "up" as const : "down" as const };
  }, [convergenceHistory]);

  const statusLabel = (() => {
    switch (loopPhase) {
      case "before-loop-dialog": return t("swarm.planningDialog", "Planning (Dialog)");
      case "before-loop-debate": return t("swarm.planningDebate", "Planning (Debate)");
      case "before-loop-confirm": return t("swarm.readyToStart", "Ready to Start");
      case "running": return t("swarm.running", "Running");
      case "blocked": return t("swarm.blocked", "Blocked");
      case "after-loop": return t("swarm.afterLoop", "After Loop");
      default: return isRunning ? t("swarm.running", "Running") : swarmState?.status === "idle" ? t("swarm.idle", "Idle") : swarmState?.status ?? t("swarm.unknown", "Unknown");
    }
  })();

  const statusColor = (() => {
    switch (loopPhase) {
      case "before-loop-dialog":
      case "before-loop-debate":
        return "text-primary";
      case "before-loop-confirm":
        return "text-status-info";
      case "running":
        return "text-status-success";
      case "blocked":
        return "text-status-danger";
      case "after-loop":
        return "text-status-accent";
      default:
        return "text-muted-foreground";
    }
  })();

  return (
    <div className="flex flex-col h-full">
      {/* Top bar: status + view mode only.
          Cancel/Stop controls live in the ChatView input bar (state-changing position). */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-background/50">
        <div className="flex items-center gap-3">
          <span className={`text-sm font-medium ${statusColor}`}>
            ● {statusLabel}
          </span>
          <div className="flex items-center gap-0.5 bg-card rounded-lg p-0.5">
              <Button variant={viewMode === "chat" ? "secondary" : "ghost"} size="xs" onClick={() => setViewMode("chat")}>
                <MessageSquare size={12} /> Chat
              </Button>
              <Button variant={viewMode === "topology" ? "secondary" : "ghost"} size="xs" onClick={() => setViewMode("topology")}>
                <GitGraph size={12} /> Topology
              </Button>
              <Button variant={viewMode === "timeline" ? "secondary" : "ghost"} size="xs" onClick={() => setViewMode("timeline")}>
                <Clock size={12} /> Timeline
              </Button>
              <Button variant={viewMode === "files" ? "secondary" : "ghost"} size="xs" onClick={() => setViewMode("files")}>
                <FileText size={12} /> Files
              </Button>
              <Button variant={viewMode === "roles" ? "secondary" : "ghost"} size="xs" onClick={() => setViewMode("roles")}>
                <Users size={12} /> Roles
              </Button>
              <Button variant={viewMode === "scaling" ? "secondary" : "ghost"} size="xs" onClick={() => setViewMode("scaling")}>
                <GitBranch size={12} /> Scaling
              </Button>
              <Button variant={viewMode === "commatrix" ? "secondary" : "ghost"} size="xs" onClick={() => setViewMode("commatrix")}>
                <ArrowRightLeft size={12} /> Comm
              </Button>
              {afterLoopResult && (
                <Button
                  variant={viewMode === "afterloop" ? "secondary" : "ghost"}
                  size="xs"
                  onClick={() => setViewMode("afterloop")}
                  className={viewMode === "afterloop" ? "text-status-accent" : ""}
                >
                  <Brain size={12} /> Summary
                </Button>
              )}
            </div>
          <span className="text-xs text-muted-foreground/60">|| {swarmState?.agents ? Object.keys(swarmState.agents).length : 0} workers</span>
          {/* P2-6: Token count + cost estimate */}
          {(swarmState?.totalTokens ?? 0) > 0 && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground" title={`${formatTokens(swarmState!.totalTokens!)} tokens · ${swarmState!.totalRequests ?? 0} requests · est. cost ${estimateCost(swarmState!.totalTokens!)}`}>
              <Zap size={11} />
              {formatTokens(swarmState!.totalTokens!)}
              <span className="text-muted-foreground/50">·</span>
              {estimateCost(swarmState!.totalTokens!)}
            </span>
          )}
          {/* P2-5: Convergence trend indicator */}
          {convergenceTrend && (
            <span className={`flex items-center gap-0.5 text-xs ${convergenceTrend.trend === "up" ? "text-status-success" : "text-primary"}`} title={`Jaccard: ${convergenceTrend.latest.toFixed(3)}`}>
              {convergenceTrend.trend === "up" ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
              {(convergenceTrend.latest * 100).toFixed(0)}%
            </span>
          )}
          <span className="flex items-center gap-1 text-xs text-muted-foreground/60">
            {isConnected ? (
              <><Wifi size={12} className="text-status-success" /> SSE</>
            ) : (
              <><WifiOff size={12} className="text-muted-foreground/60" /> SSE</>
            )}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            title="Toggle theme"
          >
            {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
          </Button>
        </div>

        {/* Right side: pause/resume controls + status indicators */}
        <div className="flex items-center gap-2">
          {/* Pause / Resume — available when running or paused */}
          {loopPhase === "running" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => pauseRun()}
              className="text-primary border-primary/20 hover:bg-primary/10"
              title="Pause the swarm"
            >
              <Pause size={12} />
              Pause
            </Button>
          )}
          {loopPhase === "paused" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => resumeRun()}
              className="text-status-success border-status-success/20 hover:bg-status-success/10"
              title="Resume the swarm"
            >
              <Play size={12} />
              Resume
            </Button>
          )}

          {/* Debate in progress indicator */}
          {loopPhase === "before-loop-debate" && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-status-accent">
              <Loader2 size={14} className="animate-spin" />
              Debating...
            </div>
          )}

          {/* After-loop processing indicator */}
          {loopPhase === "after-loop" && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-status-accent">
              <Loader2 size={14} className="animate-spin" />
              Processing...
            </div>
          )}
        </div>
      </div>

      {/* Phase pipeline — visible in all phases except idle */}
      {loopPhase !== "idle" && <PhasePipeline />}

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {viewMode === "chat" ? (
          <>
            <ChannelList />
            <ChatView />
            <ContextPanel />
          </>
        ) : viewMode === "topology" ? (
          <div className="flex-1 relative">
            <AgentTopology />
          </div>
        ) : viewMode === "timeline" ? (
          <div className="flex-1 relative">
            <AgentTimeline />
          </div>
        ) : viewMode === "files" ? (
          <div className="flex-1 relative">
            <FileChangesPanel />
          </div>
        ) : viewMode === "scaling" ? (
          <div className="flex-1 relative">
            <ScalingHistory />
          </div>
        ) : viewMode === "commatrix" ? (
          <div className="flex-1 relative">
            <CommMatrix />
          </div>
        ) : viewMode === "afterloop" ? (
          <div className="flex-1 overflow-y-auto p-4">
            <AfterLoopPanel />
          </div>
        ) : (
          <div className="flex-1 relative">
            <RoleBrowser />
          </div>
        )}
      </div>

      {/* Blocker resolution dialog — shown when loopPhase === "blocked" */}
      <BlockerDialog />
    </div>
  );
}
