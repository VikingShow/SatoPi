# Task: Fix Race Condition in Event Processor

Fix a race condition in `src/event-processor.ts`. The `processEvents` function uses a global shared counter (`processedCount`) that is incremented from multiple concurrent event handlers without synchronization, causing lost updates under concurrent load.

**Requirements:**
1. Fix the race condition by using proper synchronization (e.g., a lock, a sequential queue, or an atomic counter)
2. The fix must support concurrent processing (don't just make everything synchronous)
3. `processEvents` must still accept an array of events and process them
4. `getProcessedCount()` must return the accurate count after all events are processed
5. Preserve the existing `Event` and `ProcessedEvent` interfaces
6. Do NOT change any other files
