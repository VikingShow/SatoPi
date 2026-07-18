import { useSwarmStore } from "../../stores/swarm-store";
import { useThemeStore } from "../../stores/theme-store";
import { Wifi, WifiOff, Loader2, GitGraph, MessageSquare, Users, Sun, Moon, Pause, Play, TrendingUp, TrendingDown, Zap } from "lucide-react";
import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import ChannelList from "./ChannelList";
import ChatView from "./ChatView";
import ContextPanel from "./ContextPanel";
import PhasePipeline from "./PhasePipeline";
import BlockerDialog from "./BlockerDialog";
import AgentTopology from "./AgentTopology";
import RoleBrowser from "./RoleBrowser";

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
  const swarmState = useSwarmStore((s) => s.swarmState);
  const isRunning = useSwarmStore((s) => s.isRunning);
  const isConnected = useSwarmStore((s) => s.isConnected);
  const loopPhase = useSwarmStore((s) => s.loopPhase);
  const convergenceHistory = useSwarmStore((s) => s.convergenceHistory);
  const pauseRun = useSwarmStore((s) => s.pauseRun);
  const resumeRun = useSwarmStore((s) => s.resumeRun);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<"chat" | "topology" | "roles">("chat");

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
        return "text-amber-400";
      case "before-loop-confirm":
        return "text-blue-400";
      case "running":
        return "text-emerald-400";
      case "blocked":
        return "text-red-400";
      case "after-loop":
        return "text-purple-400";
      default:
        return "text-neutral-500";
    }
  })();

  return (
    <div className="flex flex-col h-full">
      {/* Top bar: status + view mode only.
          Cancel/Stop controls live in the ChatView input bar (state-changing position). */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-800 bg-neutral-900/50">
        <div className="flex items-center gap-3">
          <span className={`text-sm font-medium ${statusColor}`}>
            ● {statusLabel}
          </span>
          <div className="flex items-center gap-0.5 bg-neutral-800 rounded-lg p-0.5">
              <button
                onClick={() => setViewMode("chat")}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  viewMode === "chat" ? "bg-neutral-700 text-neutral-200" : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                <MessageSquare size={12} /> Chat
              </button>
              <button
                onClick={() => setViewMode("topology")}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  viewMode === "topology" ? "bg-neutral-700 text-neutral-200" : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                <GitGraph size={12} /> Topology
              </button>
              <button
                onClick={() => setViewMode("roles")}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  viewMode === "roles" ? "bg-neutral-700 text-neutral-200" : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                <Users size={12} /> Roles
              </button>
            </div>
          <span className="text-xs text-neutral-600">|| {swarmState?.agents ? Object.keys(swarmState.agents).length : 0} workers</span>
          {/* P2-6: Token count + cost estimate */}
          {(swarmState?.totalTokens ?? 0) > 0 && (
            <span className="flex items-center gap-1 text-xs text-neutral-500" title={`${formatTokens(swarmState!.totalTokens!)} tokens · ${swarmState!.totalRequests ?? 0} requests · est. cost ${estimateCost(swarmState!.totalTokens!)}`}>
              <Zap size={11} />
              {formatTokens(swarmState!.totalTokens!)}
              <span className="text-neutral-700">·</span>
              {estimateCost(swarmState!.totalTokens!)}
            </span>
          )}
          {/* P2-5: Convergence trend indicator */}
          {convergenceTrend && (
            <span className={`flex items-center gap-0.5 text-xs ${convergenceTrend.trend === "up" ? "text-emerald-400" : "text-amber-400"}`} title={`Jaccard: ${convergenceTrend.latest.toFixed(3)}`}>
              {convergenceTrend.trend === "up" ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
              {(convergenceTrend.latest * 100).toFixed(0)}%
            </span>
          )}
          <span className="flex items-center gap-1 text-xs text-neutral-600">
            {isConnected ? (
              <><Wifi size={12} className="text-emerald-400" /> SSE</>
            ) : (
              <><WifiOff size={12} className="text-neutral-600" /> SSE</>
            )}
          </span>
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="p-1 rounded-md text-neutral-500 hover:text-neutral-300 hover:bg-neutral-700 transition-colors cursor-pointer"
            title="Toggle theme"
          >
            {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </div>

        {/* Right side: pause/resume controls + status indicators */}
        <div className="flex items-center gap-2">
          {/* Pause / Resume — available when running or paused */}
          {loopPhase === "running" && (
            <button
              onClick={() => pauseRun()}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 rounded-md transition-colors cursor-pointer"
              title="Pause the swarm"
            >
              <Pause size={12} />
              Pause
            </button>
          )}
          {loopPhase === "paused" && (
            <button
              onClick={() => resumeRun()}
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 rounded-md transition-colors cursor-pointer"
              title="Resume the swarm"
            >
              <Play size={12} />
              Resume
            </button>
          )}

          {/* Debate in progress indicator */}
          {loopPhase === "before-loop-debate" && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-purple-400">
              <Loader2 size={14} className="animate-spin" />
              Debating...
            </div>
          )}

          {/* After-loop processing indicator */}
          {loopPhase === "after-loop" && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-purple-400">
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
