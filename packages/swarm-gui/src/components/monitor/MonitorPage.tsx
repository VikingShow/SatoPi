import { useSwarmStore } from "../../stores/swarm-store";
import { Play, Square, Wifi, WifiOff } from "lucide-react";
import ChannelList from "./ChannelList";
import ChatView from "./ChatView";
import ContextPanel from "./ContextPanel";
import PhasePipeline from "./PhasePipeline";

export default function MonitorPage() {
  const swarmState = useSwarmStore((s) => s.swarmState);
  const isRunning = useSwarmStore((s) => s.isRunning);
  const isConnected = useSwarmStore((s) => s.isConnected);
  const startRun = useSwarmStore((s) => s.startRun);
  const stopRun = useSwarmStore((s) => s.stopRun);

  const statusLabel = isRunning
    ? "Running"
    : swarmState?.status === "idle"
      ? "Idle"
      : swarmState?.status ?? "Unknown";

  const statusColor = isRunning
    ? "text-emerald-400"
    : "text-neutral-500";

  return (
    <div className="flex flex-col h-full">
      {/* Top bar: status + controls */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-800 bg-neutral-900/50">
        <div className="flex items-center gap-3">
          <span className={`text-sm font-medium ${statusColor}`}>
            ● {statusLabel}
          </span>
          <span className="text-xs text-neutral-600">
            {swarmState?.agents ? Object.keys(swarmState.agents).length : 0} workers
          </span>
          <span className="flex items-center gap-1 text-xs text-neutral-600">
            {isConnected ? (
              <><Wifi size={12} className="text-emerald-400" /> SSE</>
            ) : (
              <><WifiOff size={12} className="text-neutral-600" /> SSE</>
            )}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {isRunning ? (
            <button
              onClick={() => stopRun()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-500 rounded-md transition-colors"
            >
              <Square size={14} fill="currentColor" />
              Stop Swarm
            </button>
          ) : (
            <button
              onClick={() => startRun()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-amber-600 hover:bg-amber-500 rounded-md transition-colors"
            >
              <Play size={14} fill="currentColor" />
              Start Swarm
            </button>
          )}
        </div>
      </div>

      {/* Phase pipeline (only when running) */}
      {isRunning && <PhasePipeline />}

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        <ChannelList />
        <ChatView />
        <ContextPanel />
      </div>
    </div>
  );
}
