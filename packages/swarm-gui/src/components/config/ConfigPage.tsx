import { useEffect } from "react";
import { Save, Square, FileText, ArrowRight } from "lucide-react";
import { useConfigStore } from "../../stores/config-store";
import { useSwarmStore } from "../../stores/swarm-store";

interface ConfigPageProps {
  onNavigateToMonitor?: () => void;
}

export default function ConfigPage({ onNavigateToMonitor }: ConfigPageProps) {
  const config = useConfigStore();
  const { workers, cloners, convergence, scaling, loop, yamlPreview, isDirty, isLoading, availableModels } = config;
  const isRunning = useSwarmStore((s) => s.isRunning);
  const stopRun = useSwarmStore((s) => s.stopRun);

  useEffect(() => {
    config.loadConfig();
    config.loadModels();
  }, []);

  function NumberField({ label, value, onChange, min, max, step }: {
    label: string; value: number; onChange: (v: number) => void;
    min?: number; max?: number; step?: number;
  }) {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-xs text-neutral-500">{label}</label>
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          min={min} max={max} step={step}
          className="bg-background-elevated text-neutral-200 text-sm px-3 py-1.5 rounded-lg border border-background-border focus:border-primary/50 focus:outline-hidden"
        />
      </div>
    );
  }

  function ToggleField({ label, checked, onChange }: {
    label: string; checked: boolean; onChange: (v: boolean) => void;
  }) {
    return (
      <div className="flex items-center justify-between">
        <label className="text-xs text-neutral-500">{label}</label>
        <button
          onClick={() => onChange(!checked)}
          className={`w-9 h-5 rounded-full transition-colors cursor-pointer ${checked ? "bg-primary" : "bg-background-border"}`}
        >
          <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Form area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Workers */}
        <div className="bg-background-card rounded-card border border-background-border p-4">
          <h3 className="text-sm font-medium text-neutral-200 mb-3">Workers</h3>
          <div className="grid grid-cols-3 gap-3">
            <NumberField label="Initial" value={workers.initial} onChange={(v) => config.updateWorkers({ initial: v })} min={1} max={20} />
            <NumberField label="Min" value={workers.min} onChange={(v) => config.updateWorkers({ min: v })} min={1} max={20} />
            <NumberField label="Max" value={workers.max} onChange={(v) => config.updateWorkers({ max: v })} min={1} max={50} />
            <NumberField label="Max Rounds" value={workers.maxRounds} onChange={(v) => config.updateWorkers({ maxRounds: v })} min={1} max={10} />
            <NumberField label="Convergence Threshold" value={workers.roundsConvergenceThreshold} onChange={(v) => config.updateWorkers({ roundsConvergenceThreshold: v })} min={1} max={10} />
            <div className="flex flex-col gap-1">
              <label className="text-xs text-neutral-500">Model</label>
              <select
                value={workers.model}
                onChange={(e) => config.updateWorkers({ model: e.target.value })}
                className="bg-background-elevated text-neutral-200 text-sm px-3 py-1.5 rounded-lg border border-background-border focus:border-primary/50 focus:outline-hidden"
              >
                {availableModels.length === 0 && <option value={workers.model}>{workers.model}</option>}
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name ?? m.id}{m.provider ? ` (${m.provider})` : ""}
                  </option>
                ))}
                {!availableModels.some((m) => m.id === workers.model) && availableModels.length > 0 && (
                  <option value={workers.model}>{workers.model} (configured)</option>
                )}
              </select>
            </div>
          </div>
          <div className="mt-3">
            <ToggleField label="Auto (TaskComplexityAnalyzer)" checked={workers.auto} onChange={(v) => config.updateWorkers({ auto: v })} />
          </div>
        </div>

        {/* Cloners */}
        <div className="bg-background-card rounded-card border border-background-border p-4">
          <h3 className="text-sm font-medium text-neutral-200 mb-3">Cloners</h3>
          <div className="grid grid-cols-3 gap-3">
            <NumberField label="Count" value={cloners.count} onChange={(v) => config.updateCloners({ count: v })} min={1} max={10} />
            <div className="flex flex-col gap-1">
              <label className="text-xs text-neutral-500">Model</label>
              <select
                value={cloners.model}
                onChange={(e) => config.updateCloners({ model: e.target.value })}
                className="bg-background-elevated text-neutral-200 text-sm px-3 py-1.5 rounded-lg border border-background-border focus:border-primary/50 focus:outline-hidden"
              >
                {availableModels.length === 0 && <option value={cloners.model}>{cloners.model}</option>}
                {availableModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
                {!availableModels.some((m) => m.id === cloners.model) && availableModels.length > 0 && (
                  <option value={cloners.model}>{cloners.model} (configured)</option>
                )}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-neutral-500">Review Strictness</label>
              <select value={cloners.reviewStrictness} onChange={(e) => config.updateCloners({ reviewStrictness: e.target.value })}
                className="bg-background-elevated text-neutral-200 text-sm px-3 py-1.5 rounded-lg border border-background-border focus:border-primary/50 focus:outline-hidden">
                <option value="strict">Strict</option>
                <option value="normal">Normal</option>
                <option value="lenient">Lenient</option>
              </select>
            </div>
          </div>
        </div>

        {/* Loop + Convergence */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-background-card rounded-card border border-background-border p-4">
            <h3 className="text-sm font-medium text-neutral-200 mb-3">Loop</h3>
            <div className="space-y-3">
              <NumberField label="Max Iterations" value={loop.maxIterations} onChange={(v) => config.updateLoop({ maxIterations: v })} min={1} max={20} />
              <ToggleField label="Human Escalation" checked={loop.humanEscalation} onChange={(v) => config.updateLoop({ humanEscalation: v })} />
            </div>
          </div>
          <div className="bg-background-card rounded-card border border-background-border p-4">
            <h3 className="text-sm font-medium text-neutral-200 mb-3">Convergence</h3>
            <div className="space-y-3">
              <NumberField label="Jaccard Threshold" value={convergence.threshold} onChange={(v) => config.updateConvergence({ threshold: v })} min={0} max={1} step={0.05} />
              <NumberField label="Approval Ratio" value={convergence.approvalRatio} onChange={(v) => config.updateConvergence({ approvalRatio: v })} min={0} max={1} step={0.05} />
            </div>
          </div>
        </div>

        {/* Scaling */}
        <div className="bg-background-card rounded-card border border-background-border p-4">
          <h3 className="text-sm font-medium text-neutral-200 mb-3">Scaling Policy</h3>
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Super-Majority Threshold" value={scaling.superMajorityThreshold} onChange={(v) => config.updateScaling({ superMajorityThreshold: v })} min={0} max={1} step={0.05} />
            <NumberField label="Majority Threshold" value={scaling.majorityThreshold} onChange={(v) => config.updateScaling({ majorityThreshold: v })} min={0} max={1} step={0.05} />
          </div>
        </div>
      </div>

      {/* YAML preview */}
      <div className="w-96 flex flex-col border-l border-background-border bg-background-card">
        <div className="px-3 py-2 border-b border-background-border flex items-center gap-2">
          <FileText size={14} className="text-neutral-500" />
          <span className="text-xs font-medium text-neutral-400 uppercase tracking-wider">loop.yaml Preview</span>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <pre className="text-xs font-mono text-neutral-400 whitespace-pre-wrap">{yamlPreview || "# Loading..."}</pre>
        </div>
        <div className="px-3 py-2.5 border-t border-background-border flex items-center gap-2">
          <button
            onClick={() => config.saveConfig()}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
              isDirty ? "bg-primary/20 text-primary hover:bg-primary/30" : "bg-background-elevated text-neutral-600"
            }`}
          >
            <Save size={13} /> Save
          </button>
          <button
            onClick={() => { config.saveConfig(); onNavigateToMonitor?.(); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:bg-primary-hover transition-colors cursor-pointer"
            title="Save config and go to Monitor to start planning"
          >
            Save & Plan <ArrowRight size={12} />
          </button>
          {isRunning ? (
            <button
              onClick={() => stopRun()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-600/20 text-red-400 hover:bg-red-600/30 transition-colors cursor-pointer ml-auto"
            >
              <Square size={13} fill="currentColor" /> Stop
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
