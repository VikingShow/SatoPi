// TUI rendering and streaming output

export { renderAgentPanel } from "../tui/agent-panel";
export {
	type CommMessage,
	renderCommPanel,
} from "../tui/comm-panel";
export {
	type AgentContextInfo,
	type ContextPanelState,
	type ContextSourceStatus,
	renderContextPanel,
} from "../tui/context-panel";
export { renderPhaseView } from "../tui/phase-view";
// SatoPi v3 TUI dashboard
export { renderSplash } from "../tui/splash";
export {
	type DashboardInput,
	renderDashboard,
} from "../tui/swarm-dashboard";
export {
	ansiBold,
	ansiDim,
	ansiFg,
	PHASE_DISPLAY,
	PI_LOGO_ASCII,
	SATOPI_COLORS,
} from "../tui/theme";
export { createStreamProgressHandler, streamAgentOutput } from "./streaming";
