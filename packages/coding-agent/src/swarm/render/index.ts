// TUI rendering and streaming output
//
// NOTE: The dashboard/panel render functions moved to
// `modes/components/swarm/` (the system TUI component layer) and are wrapped by
// SwarmDashboardComponent there. Only the swarm-owned splash/theme/streaming
// helpers remain re-exported here.

export { renderSplash } from "../tui/splash";
export {
	ansiBold,
	ansiDim,
	ansiFg,
	PHASE_DISPLAY,
	PI_LOGO_ASCII,
	SATOPI_COLORS,
} from "../tui/theme";
export { createStreamProgressHandler, streamAgentOutput } from "./streaming";
