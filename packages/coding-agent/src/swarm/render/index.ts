// TUI rendering and streaming output
export { renderSwarmProgress } from "./render";
export { createStreamProgressHandler, streamAgentOutput } from "./streaming";

// SatoPi v3 TUI dashboard
export {
  renderSplash,
} from "../tui/splash";
export {
  renderDashboard,
  type DashboardInput,
} from "../tui/swarm-dashboard";
export {
  renderPhaseView,
} from "../tui/phase-view";
export {
  renderAgentPanel,
} from "../tui/agent-panel";
export {
  renderCommPanel,
  type CommMessage,
} from "../tui/comm-panel";
export {
  renderContextPanel,
  type ContextPanelState,
  type ContextSourceStatus,
  type AgentContextInfo,
} from "../tui/context-panel";
export {
  SATOPI_COLORS,
  PHASE_DISPLAY,
  PI_LOGO_ASCII,
  ansiFg,
  ansiBold,
  ansiDim,
} from "../tui/theme";
