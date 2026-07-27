// TUI rendering and streaming output
//
// NOTE: The dashboard/panel render functions and shared theme/splash helpers
// have moved to `modes/components/swarm/` (the system TUI component layer).
// This barrel re-exports from there for callers that go through `swarm/render`.

export { renderSplash } from "../../modes/components/swarm/splash";
export {
	PI_LOGO_ASCII,
	PHASE_DISPLAY,
	sato,
	phaseColor,
} from "../../modes/components/swarm/theme";
