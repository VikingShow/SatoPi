// File locking, tracking, and stigmergic coordination
export { RegionLockManager } from "./region-lock";
export { FileTracker, type FileRoundSummary } from "./file-tracker";
export { checkContextBudget, guardTaskBudget, type ContextGuardResult, type ContextGuardOptions } from "./context-guard";
export { MarkEnvironment, type Mark, type MarkType, type MarkPriority } from "./mark-environment";
