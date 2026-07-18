import { useSwarmStore } from "../../stores/swarm-store";
import { Square, Wifi, WifiOff, X, Loader2, GitGraph, MessageSquare } from "lucide-react";
import { useState } from "react";
import ChannelList from "./ChannelList";
import ChatView from "./ChatView";
import ContextPanel from "./ContextPanel";
import PhasePipeline from "./PhasePipeline";
import BlockerDialog from "./BlockerDialog";
import AgentTopology from "./AgentTopology";

export default function MonitorPage() {
  const swarmState = useSwarmStore((s) => s.swarmState);
  const isRunning = useSwarmStore((s) => s.isRunning);
  const isConnected = useSwarmStore((s) => s.isConnected);
  const loopPhase = useSwarmStore((s) => s.loopPhase);
  const beforeLoopState = useSwarmStore((s) => s.beforeLoopState);
  const stopRun = useSwarmStore((s) => s.stopRun);
  const cancelBeforeLoop = useSwarmStore((s) => s.cancelBeforeLoop);
  const [viewMode, setViewMode] = useState<"chat" | "topology">("chat");

  const isBusy = beforeLoopState?.busy ?? false;
  const isActive = loopPhase === "running" || loopPhase === "blocked";

  const statusLabel = (() => {
    switch (loopPhase) {
      case "before-loop-dialog": return "Planning (Dialog)";
      case "before-loop-debate": return "Planning (Debate)";
      case "before-loop-confirm": return "Ready to Start";
      case "running": return "Running";
      case "blocked": return "Blocked";
      case "after-loop": return "After Loop";
      default: return isRunning ? "Running" : swarmState?.status === "idle" ? "Idle" : swarmState?.status ?? "Unknown";
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
      {/* Top bar: status + safety controls only */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-800 bg-neutral-900/50">
        <div className="flex items-center gap-3">
          <span className={`text-sm font-medium ${statusColor}`}>
            ● {statusLabel}
          </span>
          {isActive && (
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
            </div>
          )}
          <span className="text-xs text-neutral-600">|| {swarmState?.agents ? Object.keys(swarmState.agents).length : 0} workers</span>
          <span className="flex items-center gap-1 text-xs text-neutral-600">
            {isConnected ? (
              <><Wifi size={12} className="text-emerald-400" /> SSE</>
            ) : (
              <><WifiOff size={12} className="text-neutral-600" /> SSE</>
            )}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Cancel — abort Before Loop planning */}
          {(loopPhase === "before-loop-dialog" || loopPhase === "before-loop-confirm") && (
            <button
              onClick={() => cancelBeforeLoop()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-neutral-300 bg-neutral-700 hover:bg-neutral-600 rounded-md transition-colors"
            >
              <X size={14} />
              Cancel
            </button>
          )}

          {/* Debate in progress indicator */}
          {loopPhase === "before-loop-debate" && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-purple-400">
              <Loader2 size={14} className="animate-spin" />
              Debating...
            </div>
          )}

          {/* Stop Swarm — safety control during running */}
          {loopPhase === "running" && isRunning && (
            <button
              onClick={() => stopRun()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-500 rounded-md transition-colors"
            >
              <Square size={14} fill="currentColor" />
              Stop Swarm
            </button>
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
        ) : (
          <div className="flex-1 relative">
            <AgentTopology />
          </div>
        )}
      </div>

      {/* Blocker resolution dialog — shown when loopPhase === "blocked" */}
      <BlockerDialog />
    </div>
  );
}
