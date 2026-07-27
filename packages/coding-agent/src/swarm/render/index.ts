// TUI rendering and streaming output
//
// NOTE: The dashboard/panel render functions and shared theme/splash helpers
// have moved to `modes/components/swarm/` (the system TUI component layer).
// This barrel re-exports from there for callers that go through `swarm/render`.

export { renderSplash } from "../../modes/components/swarm/splash";
export {
	ansiBold,
	ansiDim,
	ansiFg,
	PHASE_DISPLAY,
	PI_LOGO_ASCII,
	SATOPI_COLORS,
} from "../../modes/components/swarm/theme";
export { createStreamProgressHandler, streamAgentOutput } from "./streaming";
