# Task: Add Priority Parameter to Task Scheduler

Update the task scheduling API to support task priority levels. The `scheduleTask` function in `src/scheduler.ts` currently lacks priority support.

**Requirements:**
1. Add a `TaskPriority` enum with values: `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`
2. Add an optional `priority` field to `TaskOptions` (default: `MEDIUM`)
3. Modify `scheduleTask` to accept and propagate the priority
4. Update `submitBatchTasks` in the same file to pass priority through
5. The existing callers (no priority passed) should still work with default `MEDIUM` priority
6. The `priority` must be included in the `ScheduledTask` result object
7. Do NOT change any other files
