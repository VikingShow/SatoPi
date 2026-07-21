import { useEffect, useState, lazy, Suspense, useCallback } from "react";
import { Settings, Activity, History, PlusCircle, Sparkles, Languages } from "lucide-react";
import { Toaster } from "sonner";
import { useTranslation } from "react-i18next";
import { useSwarmStore } from "./stores/swarm-store";
import { useSessionStore } from "./stores/session-store";
import { useConfigStore } from "./stores/config-store";
import { useGlobalKeybindings } from "./hooks/use-keybindings";
import { Button } from "./components/ui/button";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./i18n";
import MonitorPage from "./components/monitor/MonitorPage";
import SessionSwitcher from "./components/monitor/SessionSwitcher";

// Lazy-loaded pages — Config and History are secondary views
const ConfigPage = lazy(() => import("./components/config/ConfigPage"));
const HistoryPage = lazy(() => import("./components/history/HistoryPage"));

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-full text-muted-foreground">
      <div className="flex flex-col items-center gap-2">
        <div className="w-5 h-5 border-2 border-border border-t-primary rounded-full animate-spin" />
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
  const saveConfig = useConfigStore((s) => s.saveConfig);
  const { t, i18n } = useTranslation();

  // Global keyboard shortcuts
  const keyHandlers = useCallback({
    send: () => window.dispatchEvent(new CustomEvent("satopi:action", { detail: "send" })),
    escape: () => window.dispatchEvent(new CustomEvent("satopi:action", { detail: "escape" })),
    save: () => { if (page === "config") saveConfig(); },
    command: () => console.debug("[keybinding] command palette (not yet implemented)"),
    toggleTopology: () => window.dispatchEvent(new CustomEvent("satopi:action", { detail: "toggleTopology" })),
  }, [page, saveConfig]);
  useGlobalKeybindings(keyHandlers);

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
    { id: "config", label: t("nav.config"), icon: <Settings size={18} /> },
    { id: "monitor", label: t("nav.monitor"), icon: <Activity size={18} /> },
    { id: "history", label: t("nav.history"), icon: <History size={18} /> },
  ];

  const status = swarmState?.status ?? "idle";
  const statusColor =
    status === "running" ? "text-status-warning" :
    status === "completed" ? "text-status-success" :
    status === "failed" ? "text-status-danger" :
    "text-muted-foreground";

  // Brand-first header: always show "SatoPi" as the product, with the swarm
  // name (from the backend StateTracker) as a secondary identifier
  const brandName = "SatoPi";
  const swarmLabel = swarmState?.name && swarmState.name !== "SatoPi"
    ? `· ${swarmState.name}`
    : "";

  return (
    <div className="flex h-screen bg-background text-foreground/90">
      <Toaster position="bottom-right" theme="dark" richColors />
      {/* Sidebar */}
      <aside className="w-14 flex flex-col items-center py-4 gap-2 border-r border-border bg-background-card">
        <div
          className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center mb-4"
          title="SatoPi — Satori, a team of Pi"
        >
          <Sparkles size={18} className="text-primary" />
        </div>
        {navItems.map((item) => (
          <Button
            key={item.id}
            variant="ghost"
            size="icon"
            onClick={() => setPage(item.id)}
            className={page === item.id ? "bg-primary/15 text-primary" : ""}
            title={item.label}
          >
            {item.icon}
          </Button>
        ))}
        {/* Spacer */}
        <div className="flex-1" />
        {/* Language toggle */}
        <Button
          variant="ghost"
          size="icon"
          onClick={() => i18n.changeLanguage(i18n.language === "en" ? "zh" : "en")}
          title={i18n.language === "en" ? "切换到中文" : "Switch to English"}
        >
          <Languages size={16} />
        </Button>
        {/* New Session */}
        <Button
          variant="ghost"
          size="icon"
          onClick={async () => {
            setNewSessionBusy(true);
            await newSession();
            setNewSessionBusy(false);
            setPage("monitor");
          }}
          disabled={newSessionBusy || isRunning}
          className="hover:text-status-success hover:bg-status-success/10"
          title={t("session.newSession")}
        >
          <PlusCircle size={20} className={newSessionBusy ? "animate-spin" : ""} />
        </Button>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="h-12 flex items-center justify-between px-4 border-b border-border bg-background-card">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium tracking-tight">{brandName}</span>
            <span className="text-muted-foreground/50">/</span>
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
                connecting: { label: "Connecting…", text: "text-muted-foreground", dot: "bg-muted-foreground animate-pulse" },
                reconnecting: { label: "Reconnecting…", text: "text-primary", dot: "bg-primary animate-pulse" },
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
          <ErrorBoundary>
            {page === "config" && <Suspense fallback={<PageLoader />}><ConfigPage onNavigateToMonitor={() => setPage("monitor")} /></Suspense>}
            {page === "monitor" && <MonitorPage />}
            {page === "history" && <Suspense fallback={<PageLoader />}><HistoryPage /></Suspense>}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}

export default App;
