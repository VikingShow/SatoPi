import { useEffect, useState, lazy, Suspense } from "react";
import { Settings, Activity, History, PlusCircle, Sparkles } from "lucide-react";
import { Toaster } from "sonner";
import { useSwarmStore } from "./stores/swarm-store";
import { useSessionStore } from "./stores/session-store";
import MonitorPage from "./components/monitor/MonitorPage";
import SessionSwitcher from "./components/monitor/SessionSwitcher";

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
  const [hydrated, setHydrated] = useState(false);
  const init = useSwarmStore((s) => s.init);
  const swarmState = useSwarmStore((s) => s.swarmState);
  const connectionStatus = useSwarmStore((s) => s.connectionStatus);
  const isRunning = useSwarmStore((s) => s.isRunning);
  const newSession = useSessionStore((s) => s.newSession);
  const loadRuns = useSessionStore((s) => s.loadRuns);
  const [newSessionBusy, setNewSessionBusy] = useState(false);

  // Delay init() until Zustand's persist middleware has rehydrated
  // activeSwarm from localStorage.  Otherwise getActiveSession() (used
  // inside swarm-store init()) returns null and falls back to the default
  // "SatoPi" session, causing cross-session message leakage.
  useEffect(() => {
    const store = useSessionStore as any;
    if (store.persist?.hasHydrated?.()) {
      setHydrated(true);
      return;
    }
    const unsub = store.persist?.onFinishHydration(() => setHydrated(true));
    return () => { unsub?.(); };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    init();
    loadRuns();
  }, [hydrated, init, loadRuns]);

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

  // Brand-first header: always show "SatoPi" as the product, with the swarm
  // name (from the backend StateTracker) as a secondary identifier
  const brandName = "SatoPi";
  const swarmLabel = swarmState?.name && swarmState.name !== "SatoPi"
    ? `· ${swarmState.name}`
    : "";

  return (
    <div className="flex h-screen bg-background text-neutral-100">
      <Toaster position="bottom-right" theme="dark" richColors />
      {/* Sidebar */}
      <aside className="w-14 flex flex-col items-center py-4 gap-2 border-r border-background-border bg-background-card">
        <div
          className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center mb-4"
          title="SatoPi — Satori, a team of Pi"
        >
          <Sparkles size={18} className="text-primary" />
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
            <span className="text-sm font-medium tracking-tight">{brandName}</span>
            <span className="text-neutral-700">/</span>
            <SessionSwitcher />
            <span className={`text-xs font-mono ${statusColor}`}>
              {status === "running" && <span className="inline-block w-2 h-2 rounded-full bg-status-warning mr-1.5 animate-pulse-ring" />}
              {status.toUpperCase()}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {(() => {
              const conn = {
                live: { label: "Connected", text: "text-status-success", dot: "bg-status-success animate-pulse-ring" },
                connecting: { label: "Connecting…", text: "text-neutral-400", dot: "bg-neutral-400 animate-pulse" },
                reconnecting: { label: "Reconnecting…", text: "text-amber-400", dot: "bg-amber-400 animate-pulse" },
              }[connectionStatus];
              return (
                <span className={`text-xs ${conn.text}`}>
                  <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${conn.dot}`} />
                  {conn.label}
                </span>
              );
            })()}
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-hidden">
          {page === "config" && <Suspense fallback={<PageLoader />}><ConfigPage onNavigateToMonitor={() => setPage("monitor")} /></Suspense>}
          {page === "monitor" && <MonitorPage />}
          {page === "history" && <Suspense fallback={<PageLoader />}><HistoryPage /></Suspense>}
        </main>
      </div>
    </div>
  );
}

export default App;
