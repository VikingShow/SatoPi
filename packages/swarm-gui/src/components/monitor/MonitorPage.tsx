import { useEffect } from "react";
import { useSwarmStore } from "../../stores/swarm-store";
import ChannelList from "./ChannelList";
import ChatView from "./ChatView";
import ContextPanel from "./ContextPanel";
import PhasePipeline from "./PhasePipeline";

export default function MonitorPage() {
  const swarmState = useSwarmStore((s) => s.swarmState);
  const refreshState = useSwarmStore((s) => s.refreshState);

  // Poll state every 3 seconds as SSE fallback
  useEffect(() => {
    const interval = setInterval(refreshState, 3000);
    return () => clearInterval(interval);
  }, [refreshState]);

  if (!swarmState) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-600">
        <p className="text-sm">Waiting for swarm state...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <PhasePipeline />
      <div className="flex flex-1 overflow-hidden">
        <ChannelList />
        <ChatView />
        <ContextPanel />
      </div>
    </div>
  );
}
