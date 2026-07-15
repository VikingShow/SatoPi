# Notification System Test Plan — Gawain

## Scope

Covers the swarm-extension notification pipeline: YAML config → normalized channels → parallel dispatch → webhook/file delivery. Based on designs by Bors (schema), Dinadan (prototype), Lancelot (architecture), Tristan (transport), Lamorak (concurrency), and Gareth (integration).

## Test Architecture

```
┌─────────────────────────────────────────────────────┐
│  Smoke Tests (3)   ← validates the whole thing      │
│  Integration (8)    ← multi-component paths          │
│  Unit Tests (17)    ← single function/class          │
└─────────────────────────────────────────────────────┘
```

All tests are **hermetic** — no real network, no real file writing outside temp directories. Webhook tests use Bun's built-in `Bun.serve()` for mock HTTP servers. File channel tests use `fs.mkdtemp()` workspaces.

---

## Unit Tests (17)

### 1. Webhook Channel Normalization (`normalizeWebhook`)

| # | Test | Assertion |
|---|------|-----------|
| 1.1 | `valid minimal webhook config` | Returns `WebhookChannel` with POST, label from hostname, default retry |
| 1.2 | `url from env var resolution` | `${OMP_NOTIFY_WEBHOOK_URL}` resolved from process env, url present → channel returned |
| 1.3 | `missing url, no env fallback` | Returns `null` (graceful skip) |
| 1.4 | `PUT method override` | `method: "PUT"` → `method: "PUT"` in result |
| 1.5 | `custom label preserved` | `label: "alerts"` → `label: "alerts"` in result |
| 1.6 | `header normalization` | `headers: {X-Custom: "val"}` → `headers` map preserved, CRLF stripped from values |

### 2. Webhook Security Guards (from Galahad audit)

| # | Test | Assertion |
|---|------|-----------|
| 2.1 | `http URL rejected by default` | `http://...` → returns `null` (security log emitted) |
| 2.2 | `http URL accepted with allow_insecure_http` | `allow_insecure_http: true` + `http://...` → channel returned |
| 2.3 | `URL with embedded credentials rejected` | `https://user:pass@host` → returns `null` |
| 2.4 | `internal/loopback IP rejected (SSRF)` | `http://127.0.0.1/`, `http://169.254.169.254/`, `http://10.0.0.1/` → all return `null` |
| 2.5 | `private network allowed with allow_local_network` | `allow_local_network: true` + `http://10.0.0.1/path` → channel returned |

### 3. File Channel Normalization (`normalizeFile`)

| # | Test | Assertion |
|---|------|-----------|
| 3.1 | `valid minimal file config` | Returns `FileChannel` with append mode, label from basename |
| 3.2 | `path resolved against workspace root` | `path: "logs/notify.md"` → resolved to `<workspace>/logs/notify.md` |
| 3.3 | `path traversal rejected` | `path: "../../etc/passwd"` → returns `null` (workspace containment check) |
| 3.4 | `absolute path rejected` | `path: "/etc/cron.d/swarm"` → returns `null` |
| 3.5 | `overwrite mode` | `mode: "overwrite"` → `mode: "overwrite"` in result |
| 3.6 | `missing path, no env fallback` | Returns `null` |

### 4. Retry Policy (`normalizeRetry`)

| # | Test | Assertion |
|---|------|-----------|
| 4.1 | `default retry policy` | `maxAttempts: 3`, `backoffMs: 1000` |
| 4.2 | `custom retry values` | `retry: {max_attempts: 5, backoff_ms: 2000}` → values preserved |
| 4.3 | `max_attempts capped at 10` | `max_attempts: 999` → clamped to 10 |
| 4.4 | `backoff_ms bounds [100, 60000]` | `backoff_ms: 1` → 100; `backoff_ms: 999999` → 60000 |
| 4.5 | `snake_case → camelCase mapping` | `max_attempts` in YAML → `maxAttempts` in TypeScript |

---

## Integration Tests (8)

### 5. Webhook Dispatch

| # | Test | Assertion |
|---|------|-----------|
| 5.1 | `successful POST delivery` | Mock server receives POST, body matches payload JSON, headers include Content-Type: application/json |
| 5.2 | `custom headers forwarded` | `X-Custom: value` appears in received request headers |
| 5.3 | `HMAC signature header present` | `X-OMP-Signature` header is a valid hex string (64 chars, SHA-256) |
| 5.4 | `idempotency key unique per send` | Two successive sends produce different `X-Idempotency-Key` values |

### 6. File Channel Dispatch

| # | Test | Assertion |
|---|------|-----------|
| 6.1 | `append mode writes markdown` | File created, formatted markdown appended, second dispatch appends additional block |
| 6.2 | `overwrite mode replaces content` | File contains only the latest payload, no stale data |
| 6.3 | `template expansion ({{name}} sanitized)` | `path: "logs/{{name}}.md"`, name with `../` → rejected; name "deploy" → writes to `logs/deploy.md` |

### 7. Multi-Channel Router (`NotificationRouter.notify`)

| # | Test | Assertion |
|---|------|-----------|
| 7.1 | `all channels dispatched in parallel` | Two mock webhook servers both receive requests; timing confirms parallel execution |
| 7.2 | `one channel failure does not block others` | Webhook A times out, Webhook B still succeeds; `Promise.allSettled` result contains one rejected + one fulfilled |
| 7.3 | `notify() never throws` | Even with all channels failing, `notify()` resolves (settled promises) |
| 7.4 | `per-channel timeout enforced` | Channel with 30s response delay aborted at configured timeout (10s default) |
| 7.5 | `empty channel list is a no-op` | `notify([])` resolves immediately, no requests made |

---

## Error & Edge Case Tests (9)

### 8. Network Failure Scenarios

| # | Test | Assertion |
|---|------|-----------|
| 8.1 | `connection refused` | Mock server not started → dispatch completes with rejection, error message contains "ConnectionRefused" or "ECONNREFUSED" |
| 8.2 | `DNS resolution failure` | URL with `.invalid` TLD → dispatch completes with rejection, not a crash |
| 8.3 | `connection timeout` | Server accepts TCP but never sends HTTP response → AbortError after timeout, not hang |
| 8.4 | `response timeout (slow server)` | Server reads request but delays response beyond timeout → AbortError |

### 9. Invalid Webhook Scenarios

| # | Test | Assertion |
|---|------|-----------|
| 9.1 | `malformed URL` | `url: "not-a-url!!!"` → `normalizeWebhook` returns `null`, not a thrown exception |
| 9.2 | `URL with private IP returns null` | `https://192.168.1.1/webhook` → `null` from normalizer |
| 9.3 | `5xx response triggers retry` | Server returns 503 three times → all retry attempts logged, final result is rejection |

### 10. Payload & Sanitization

| # | Test | Assertion |
|---|------|-----------|
| 10.1 | `error messages do not contain raw URL` | Webhook URL with token in path → error message redacts path segments beyond first 2 components |
| 10.2 | `ChannelResult.channel uses label, not URL` | `label: "Slack Alerts"` → `ChannelResult.channel` is `"Slack Alerts"`, not the full URL |

### 11. Markdown Output Safety

| # | Test | Assertion |
|---|------|-----------|
| 11.1 | `payload name with markdown injection escaped` | `name: "## Fake\n[click](evil)"` → backticks or escaping applied in file output |

---

## Smoke Tests (3)

Minimal end-to-end validation after build. Run in CI before merging.

| # | Test | Command | Assertion |
|---|------|---------|-----------|
| 12.1 | `webhook smoke` | `bun test smoke/webhook.test.ts` | Mock server receives valid POST with correct JSON schema |
| 12.2 | `file channel smoke` | `bun test smoke/file.test.ts` | File written to temp dir, readable markdown |
| 12.3 | `config validation smoke` | `bun test smoke/config.test.ts` | Valid YAML loads, invalid YAML rejected with clear message |

---

## Test File Layout

```
packages/swarm-extension/test/
├── notification/
│   ├── unit/
│   │   ├── normalize-webhook.test.ts       # 1.1–1.6, 2.1–2.5
│   │   ├── normalize-file.test.ts          # 3.1–3.6
│   │   ├── normalize-retry.test.ts         # 4.1–4.5
│   │   └── payload.test.ts                 # event construction, HMAC, sanitization
│   ├── integration/
│   │   ├── webhook-dispatch.test.ts        # 5.1–5.4, 8.1–8.4, 9.3
│   │   ├── file-dispatch.test.ts           # 6.1–6.3
│   │   ├── router.test.ts                  # 7.1–7.5
│   │   └── config-pipeline.test.ts         # YAML → normalize → dispatch
│   ├── edge-cases/
│   │   ├── network-failure.test.ts         # 8.1–8.4
│   │   ├── invalid-webhook.test.ts         # 9.1–9.3
│   │   ├── sanitization.test.ts            # 10.1–10.2
│   │   └── markdown-safety.test.ts         # 11.1
│   └── smoke/
│       ├── webhook.test.ts                 # 12.1
│       ├── file.test.ts                    # 12.2
│       └── config.test.ts                  # 12.3
```

---

## CI Integration

Add to `.github/workflows/ci.yml` under the swarm-extension test bucket:

```yaml
test_swarm_notification:
  name: Test swarm notification (TS)
  runs-on: ${{ github.event_name == 'pull_request' && 'ubuntu-22.04' || 'omp-kata' }}
  needs: [check]
  timeout-minutes: 10
  steps:
    - uses: actions/checkout@v4
    - uses: ./.github/actions/bun-install
    - name: Test swarm notification
      run: bun --cwd=packages/swarm-extension test notification/
```

Add to root `package.json` scripts:

```json
"ci:test:swarm:notification": "bun --cwd=packages/swarm-extension test notification/"
```

---

## Test Running Commands

```bash
# All notification tests
bun test packages/swarm-extension/test/notification/

# Unit only
bun test packages/swarm-extension/test/notification/unit/

# Integration only
bun test packages/swarm-extension/test/notification/integration/

# Smoke only
bun test packages/swarm-extension/test/notification/smoke/

# Edge cases
bun test packages/swarm-extension/test/notification/edge-cases/
```

---

## Uncovered / Deferred

| Area | Reason |
|------|--------|
| Real Slack/Discord/GitHub webhook endpoints | Requires API credentials; deferred to manual QA |
| Disk full simulation | Requires OS-level mocking; deferred to integration testing environment |
| Concurrent dispatch with >10 channels | Lamorak deferred bounded concurrency to v2 |
| Performance benchmarks | Covered by Palamedes (separate benchmark slice) |
| DNS rebinding attack detection | Requires network-level test infra; Galahad's SSRF IP block is the primary defense |
