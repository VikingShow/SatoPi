import { useEffect, useState, lazy, Suspense } from "react";
import { Settings, Activity, History, Radio, PlusCircle } from "lucide-react";
import { Toaster } from "sonner";
import { useSwarmStore } from "./stores/swarm-store";
import { useSessionStore } from "./stores/session-store";
import MonitorPage from "./components/monitor/MonitorPage";

// Lazy-loaded pages — Config and History are secondary views
const ConfigPage = lazy(() => import("./components/config/ConfigPage"));
const HistoryPage = lazy(() => import("./components/history/HistoryPage"));

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-full text-neutral-500">
      <div className="flex flex-col items-center gap-2">
        <div className="w-5 h-5 border-2 border-neutral-600 border-t-primary rounded-full animate-spin" />
        <span className="text-xs">Loading...</span>
      </div>
    </div>
  );
}

type Page = "config" | "monitor" | "history";

function App() {
  const [page, setPage] = useState<Page>("monitor");
  const init = useSwarmStore((s) => s.init);
  const swarmState = useSwarmStore((s) => s.swarmState);
  const isConnected = useSwarmStore((s) => s.isConnected);
  const isRunning = useSwarmStore((s) => s.isRunning);
  const newSession = useSessionStore((s) => s.newSession);
  const loadRuns = useSessionStore((s) => s.loadRuns);
  const [newSessionBusy, setNewSessionBusy] = useState(false);

  useEffect(() => {
    init();
    loadRuns();
  }, [init, loadRuns]);

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
      <Toaster position="bottom-right" theme="dark" richColors />
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
        {/* Spacer */}
        <div className="flex-1" />
        {/* New Session */}
        <button
          onClick={async () => {
            setNewSessionBusy(true);
            await newSession();
            setNewSessionBusy(false);
            setPage("monitor");
          }}
          disabled={newSessionBusy || isRunning}
          className="w-10 h-10 rounded-lg flex items-center justify-center transition-colors cursor-pointer text-neutral-500 hover:text-emerald-400 hover:bg-emerald-400/10 disabled:opacity-30 disabled:cursor-not-allowed"
          title="New Session"
        >
          <PlusCircle size={20} className={newSessionBusy ? "animate-spin" : ""} />
        </button>
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
          {page === "config" && <Suspense fallback={<PageLoader />}><ConfigPage /></Suspense>}
          {page === "monitor" && <MonitorPage />}
          {page === "history" && <Suspense fallback={<PageLoader />}><HistoryPage /></Suspense>}
        </main>
      </div>
    </div>
  );
}

export default App;
