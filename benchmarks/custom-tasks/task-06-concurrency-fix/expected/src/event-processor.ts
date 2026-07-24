// Event processor — race condition fixed with sequential queue

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
let processingQueue: Promise<void> = Promise.resolve();

async function processSingleEvent(event: Event): Promise<ProcessedEvent> {
  // Simulate async processing (DB write, API call, etc.)
  await new Promise((resolve) => setTimeout(resolve, Math.random() * 50));

  // Lock-free sequential update via queued promise chain
  const current = processingQueue;
  let resolved = false;
  processingQueue = current.then(() => {
    processedCount = processedCount + 1;
    resolved = true;
  });
  await processingQueue;
  if (!resolved) {
    // Fallback: ensure we wait for our own increment
    await processingQueue;
  }

  return {
    id: event.id,
    type: event.type,
    result: `processed:${event.type}`,
  };
}

export async function processEvents(events: Event[]): Promise<ProcessedEvent[]> {
  processedCount = 0;
  processingQueue = Promise.resolve();

  // Process events concurrently for the async work,
  // but serialize the counter increment via a promise chain
  const results = await Promise.all(events.map(processSingleEvent));

  // Wait for all queued increments to complete
  await processingQueue;

  return results;
}

export function getProcessedCount(): number {
  return processedCount;
}
