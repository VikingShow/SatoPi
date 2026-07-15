{
  "file": "bors.md",
  "path": ".omp/test-workspace/bors.md",
  "summary": "Designed YAML config schema for notification channels in the swarm extension. Covers: webhook and file channel types with type-discriminated schema; env var resolution (${VAR} expressions + OMP_NOTIFY_WEBHOOK_URL / OMP_NOTIFY_FILE_PATH fallbacks); retry policy; snake_case raw YAML → camelCase normalized TypeScript; integration point at pipeline completion after buildSummaryMessage(); extensibility for future channel types. Follows existing config-file.ts, model-registry.ts, and settings.ts patterns."
}