import { useEffect, useState } from "react";
import { Settings, Activity, History, Radio } from "lucide-react";
import { useSwarmStore } from "./stores/swarm-store";
import ConfigPage from "./components/config/ConfigPage";
import MonitorPage from "./components/monitor/MonitorPage";
import HistoryPage from "./components/history/HistoryPage";

type Page = "config" | "monitor" | "history";

function App() {
  const [page, setPage] = useState<Page>("monitor");
  const init = useSwarmStore((s) => s.init);
  const swarmState = useSwarmStore((s) => s.swarmState);
  const isConnected = useSwarmStore((s) => s.isConnected);

  useEffect(() => {
    init();
  }, [init]);

  const navItems: { id: Page; label: string; icon: React.ReactNode }[] = [
    { id: "config", label: "Config", icon: <Settings size={18} /> },
    { id: "monitor", label: "Monitor", icon: <Activity size={18} /> },
    { id: "history", label: "History", icon: <History size={18} /> },
  ];

  const status = swarmState?.status ?? "idle";
  const statusColor =
    status === "running" ? "text-status-warning" :
    status === "completed" ? "text-status-success" :
    status === "failed" ? "text-status-danger" :
    "text-neutral-500";

  return (
    <div className="flex h-screen bg-background text-neutral-100">
      {/* Sidebar */}
      <aside className="w-14 flex flex-col items-center py-4 gap-2 border-r border-background-border bg-background-card">
        <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center mb-4">
          <Radio size={18} className="text-primary" />
        </div>
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => setPage(item.id)}
            className={`w-10 h-10 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
              page === item.id
                ? "bg-primary/15 text-primary"
                : "text-neutral-500 hover:text-neutral-300 hover:bg-background-elevated"
            }`}
            title={item.label}
          >
            {item.icon}
          </button>
        ))}
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="h-12 flex items-center justify-between px-4 border-b border-background-border bg-background-card">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">{swarmState?.name ?? "SatoPi Swarm"}</span>
            <span className={`text-xs font-mono ${statusColor}`}>
              {status === "running" && <span className="inline-block w-2 h-2 rounded-full bg-status-warning mr-1.5 animate-pulse-ring" />}
              {status.toUpperCase()}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs ${isConnected ? "text-status-success" : "text-neutral-600"}`}>
              <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${isConnected ? "bg-status-success" : "bg-neutral-600"}`} />
              {isConnected ? "Connected" : "Disconnected"}
            </span>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-hidden">
          {page === "config" && <ConfigPage />}
          {page === "monitor" && <MonitorPage />}
          {page === "history" && <HistoryPage />}
        </main>
      </div>
    </div>
  );
}

export default App;
