{
  "file": ".omp/test-workspace/tristan.md",
  "sections": [
    "1. Transport — POST, 8 request headers inc. idempotency key + HMAC signature",
    "2. Timeout — 10s connection, 30s per-attempt total",
    "3. Retry Policy — 3 attempts, exponential backoff (1s→2s→4s), ±25% jitter, reuses fetchWithRetry",
    "4. Payload Schema — JSON envelope with event/timestamp/delivery/swarm/result/agents[]/summary",
    "5. Signature Verification — HMAC-SHA256 over delivery.timestamp.body, GitHub/Stripe pattern",
    "6. Implementation Notes — hook point in PipelineController.run(), config aligned with Bors schema, fire-and-forget dispatch"
  ],
  "aligned_with": [
    "Bors config schema (type/webhook, url, method, headers, retry.max_attempts/backoff_ms, timeout_ms, label)",
    "Existing codebase (fetchWithRetry, buildSummaryMessage, PipelineResult)",
    "OMP_NOTIFY_WEBHOOK_URL env fallback"
  ]
}