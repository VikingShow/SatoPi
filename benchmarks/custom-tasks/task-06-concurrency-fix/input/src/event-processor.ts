// Event processor with a race condition bug
// The shared 'processedCount' variable is not thread-safe

export interface Event {
  id: number;
  type: string;
  payload: unknown;
}

export interface ProcessedEvent {
  id: number;
  type: string;
  result: string;
}

let processedCount = 0;

async function processSingleEvent(event: Event): Promise<ProcessedEvent> {
  // Simulate async processing (DB write, API call, etc.)
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 50));

  // BUG: Race condition — multiple concurrent calls can read stale processedCount
  processedCount = processedCount + 1;

  return {
    id: event.id,
    type: event.type,
    result: `processed:${event.type}`,
  };
}

export async function processEvents(events: Event[]): Promise<ProcessedEvent[]> {
  processedCount = 0;
  const results = await Promise.all(events.map(processSingleEvent));
  return results;
}

export function getProcessedCount(): number {
  return processedCount;
}
