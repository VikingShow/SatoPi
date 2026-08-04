/**
 * Barrel re-export for the `github` tool.
 *
 * Kept as a thin facade so the public module path (`tools/gh`) and package
 * export (`@satopi/pi-coding-agent/tools/gh`) stay stable while the
 * implementation lives in `tools/gh/` (stage 3 split).
 */
export * from "./gh/index";
