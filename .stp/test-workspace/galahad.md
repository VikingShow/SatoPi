# Notification Security Audit — Galahad

## Audit Scope

Bors's config schema (`bors.md`) and Dinadan's prototype (`dinadan.md`). Assessed against SatoPi codebase conventions (e.g., `collab/protocol.ts:223`, `mcp/oauth-flow.ts:120`, `resolveConfigValue` patterns).

## Findings

### 1. CRITICAL — Webhook URL Secrets Committed to YAML

**Where:** `bors.md:34` — `url: https://hooks.example.com/alerts` (literal URL in YAML), `bors.md:38` — `Authorization` header with `${ENV}` token (good), but URL itself could embed secrets.

**Issue:** The design accepts raw literal URLs in the `url` field. Many webhook services embed authentication tokens in the URL path or query string (e.g., Slack `https://hooks.slack.com/services/T/B/Q`, Discord `/webhooks/ID/TOKEN`). A literal URL in `loop.yaml` gets committed to version control — permanent, rotatable, but often overlooked.

**Codebase precedent:** The `resolveConfigValue` pattern (`config/model-registry.ts:316`) resolves `!command` and `${ENV}` expressions, but API key values (e.g. `OMP_API_KEY`) stay in env vars only — never accepted as plaintext in config.

**Recommendation:** Reject URLs containing a URL userinfo component (`user:pass@host`) or path/query segments that match known token patterns. For Slack/Discord/GitHub webhook URL patterns, emit a config-level error directing the user to the env-var channel. Strongly recommend: `url` MUST be an env-var expression (`${OMP_NOTIFY_WEBHOOK_URL}`) when the raw string contains a path segment longer than 8 alphanumeric chars — heuristic for auto-detecting embedded tokens.

### 2. HIGH — No HTTPS Enforcement

**Where:** `bors.md:199-212` (`normalizeWebhook`), `dinadan.md:105` (`fetch(this.url, ...)`).

**Issue:** `normalizeWebhook()` does not validate the URL scheme. `http://internal-webhook.local/notify` passes. Plaintext HTTP transmits secrets (Bearer tokens, API keys in headers) over cleartext — MITM on any intermediate network hop captures credentials.

**Codebase precedent:** `collab/protocol.ts:223` requires `http:` or `https:` with an extra guard on non-localhost plaintext. `mcp/oauth-flow.ts:137` requires `https:` for loopback redirect URIs. The codebase consistently validates URL schemes for sensitive endpoints.

**Recommendation:** Reject non-HTTPS URLs by default. Add an explicit `allow_insecure_http: true` opt-in for local dev/air-gapped environments. The default MUST be HTTPS-only.

### 3. HIGH — Secrets Leaked in Error Messages & Logs

**Where:** `dinadan.md:116` — `` `Webhook ${this.url} returned ${response.status}: ${await response.text()}` ``, `dinadan.md:147` — `channel: ch.name` where `ch.name` contains the full URL.

**Issue:** The webhook URL (with embedded tokens) is interpolated into:
- Error messages (line 116)
- `ChannelResult.channel` string (line 147)
- Console log output (line 220)

If error results are surfaced to the user in TUI or logged to `~/.omp/logs/`, raw webhook tokens appear in plaintext.

**Recommendation:**
- Sanitize URLs in error/log context: strip query strings, truncate path segments to first 2 components, redact `userinfo@`.
- `ChannelResult.channel` should use `label` (Bors's `label` field) as the display name, not the resolved URL.
- Enforce that `this.url` is never interpolated into exception messages — use `this.options.label ?? new URL(url).hostname`.

### 4. HIGH — File Channel Path Traversal / Arbitrary Write

**Where:** `bors.md:214-225` (`normalizeFile`), `dinadan.md:70` (`await Bun.write(this.outputPath, markdown)`).

**Issue:** `normalizeFile()` does NOT resolve the file path against the workspace root. A user or compromised YAML can specify:
- Absolute paths: `path: /etc/cron.d/swarm-notify`
- Traversal: `path: ../../.ssh/authorized_keys`
- Overwrite mode: `mode: overwrite` on arbitrary paths

`dinadan.md:70` uses `Bun.write` which auto-creates parent directories — a targeted path like `/etc/cron.d/swarm-notify` would succeed if the process has write permission.

Additionally, `{{name}}` template expansion is noted in `bors.md:85` — if `name` contains `../`, the resolved path escapes the workspace.

**Codebase precedent:** The `local://` protocol (`internal-urls/local-protocol.ts:20-23`) uses `ensureWithinRoot()` with strict `startsWith(${root}${path.sep})` checks. The write tool uses `assertEditableFile` with `resolvePlanPath`. Every filesystem write in the codebase enforces workspace containment.

**Recommendation:**
- Resolve `path` against the swarm workspace root using `path.resolve(workspace, userPath)`.
- Validate the resolved path with `ensureWithinRoot()` — reject absolute paths and traversal.
- Validate filename characters from `{{name}}` template: reject `/`, `\`, and `..` sequences before substitution.
- `mode: overwrite` on files outside `.omp/` workspace → warn or reject.

### 5. MEDIUM — SSRF via Unvalidated Webhook URLs

**Where:** `bors.md:199-212` (`normalizeWebhook`), `dinadan.md:105` (`fetch(this.url, ...)`).

**Issue:** Any URL is accepted. A compromised YAML (or malicious PR) can target internal services:
- Cloud metadata: `http://169.254.169.254/latest/meta-data/`
- Internal APIs: `http://localhost:6379/`, `http://internal-admin-api/delete-all`
- DNS rebinding targets

The fetch sends the full `NotificationPayload` body (which contains pipeline state, agent results, potential code snippets) to the target.

**Recommendation:** Block private/reserved IP ranges and loopback addresses for webhook URLs:
- `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- `169.254.0.0/16` (link-local / cloud metadata)
- `0.0.0.0`, `localhost`, `[::1]`
- Add `allow_local_network: true` opt-in for self-hosted receivers.

### 6. MEDIUM — Header Injection via YAML Headers

**Where:** `bors.md:75` — `headers?: Record<string, string>`.

**Issue:** Header values are user-supplied from YAML. If a header value contains `\r\n`, it enables HTTP response header splitting/injection. While `fetch`'s `Headers` API may reject raw `\r\n` in values, the design should still validate.

**Recommendation:** Strip or reject `\r` and `\n` characters from all header values during normalization. Log a warning if stripped content differs from original.

### 7. MEDIUM — Markdown Injection in File Channel

**Where:** `dinadan.md:159-184` (`buildMarkdown`).

**Issue:** `payload.name`, agent names, and error strings are interpolated directly into markdown without escaping:
- `payload.name = "## Fake Heading\n\n[click me](http://evil.com)"` → renders as a clickable link in any markdown viewer (GitHub, VS Code, Obsidian).
- Agent names containing backticks could break code-block formatting.

**Recommendation:** Escape markdown-sensitive characters in interpolated fields. At minimum: backticks, `[`, `]`, `(`, `)`, leading `#`. Or wrap all interpolated values in backtick code spans.

### 8. LOW — Retry Amplification

**Where:** `bors.md:95-99` (`RawRetryPolicy`).

**Issue:** `max_attempts` and `backoff_ms` have no upper bounds. `max_attempts: 999999` with `backoff_ms: 0` causes a tight retry loop, potentially DoS-ing the webhook receiver or saturating local resources.

**Recommendation:** Cap `max_attempts` at 10 and `backoff_ms` at `[100, 60000]`. These match reasonable notification delivery windows.

### 9. LOW — No Response Body Size Limit on Webhooks

**Where:** `dinadan.md:105-110`.

**Issue:** `await response.text()` reads the full response body. A malicious webhook endpoint could return an infinite/very large response body, consuming memory.

**Recommendation:** Limit response body to 64 KiB for webhook responses. Use `response.text()` only after checking `Content-Length` header, or stream with a size cap. On oversized response: log warning, treat as success (the POST succeeded).

### 10. LOW — Resolved Secrets in Long-Lived Memory

**Where:** `bors.md:196` (`resolveEnvExpr`), `bors.md:208` (`resolveHeaders`).

**Issue:** `${ENV}` expressions are resolved into JavaScript strings stored in `WebhookChannel.headers` and `WebhookChannel.url` — they persist on the heap until garbage collection. Strings in V8/JavaScriptCore cannot be zeroed. This is inherent to the runtime but worth documenting as a defense-in-depth gap.

**Recommendation:** Document that notification secrets are held in JavaScript strings (not zero-able Buffers). For high-security environments, note that the env-var approach means secrets are visible via `/proc/<pid>/environ` and debugger inspection regardless. This is the accepted trade-off in the SatoPi design.

## Summary Table

| # | Severity | Finding | Mitigation Complexity |
|---|----------|---------|----------------------|
| 1 | CRITICAL | Webhook URL secrets in committed YAML | Low — env-var enforcement |
| 2 | HIGH | No HTTPS enforcement | Trivial — scheme check |
| 3 | HIGH | Secrets in error/log output | Low — URL sanitization |
| 4 | HIGH | File path traversal / arbitrary write | Low — workspace containment |
| 5 | MEDIUM | SSRF via unvalidated webhook URLs | Medium — IP blocklist |
| 6 | MEDIUM | Header injection via YAML headers | Trivial — CRLF strip |
| 7 | MEDIUM | Markdown injection in file output | Trivial — escape interpolation |
| 8 | LOW | Retry amplification (no bounds) | Trivial — clamp values |
| 9 | LOW | No response body size limit | Trivial — stream cap |
| 10 | LOW | Secrets in long-lived GC memory | Documentation only |

## Recommended Security Bounds for `normalizeWebhook`

```typescript
function normalizeWebhook(raw: Record<string, unknown>): WebhookChannel | null {
  let url = typeof raw.url === "string" ? resolveEnvExpr(raw.url) : "";
  if (!url) url = Bun.env.OMP_NOTIFY_WEBHOOK_URL ?? "";
  if (!url) return null;

  // 1. Validate scheme: HTTPS required unless explicit opt-in
  const parsed = new URL(url);
  const allowHttp = raw.allow_insecure_http === true;
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    logger.warn("Webhook URL must use HTTPS", { label: raw.label });
    return null; // or throw for config errors
  }

  // 2. SSRF: reject internal/loopback IPs
  const hostname = parsed.hostname.toLowerCase();
  if (PRIVATE_IP_RANGES.some(r => r.test(hostname))) {
    logger.warn("Webhook URL targets internal network", { hostname, label: raw.label });
    return null;
  }

  // 3. No credentials in URL
  if (parsed.username || parsed.password) {
    logger.warn("Webhook URL contains credentials — use env var for secrets", { label: raw.label });
    return null;
  }

  // 4. Cap retry bounds
  const retry = normalizeRetry(raw.retry);
  if (retry.maxAttempts > 10) retry.maxAttempts = 10;
  if (retry.backoffMs < 100 || retry.backoffMs > 60000) retry.backoffMs = 1000;

  return {
    type: "webhook",
    url: parsed.href,
    method: raw.method === "PUT" ? "PUT" : "POST",
    headers: validateHeaders(resolveHeaders(raw.headers)),
    retry,
    label: typeof raw.label === "string" ? raw.label : parsed.hostname,
  };
}
```

## Recommended Security Bounds for `normalizeFile`

```typescript
function normalizeFile(raw: Record<string, unknown>, workspaceRoot: string): FileChannel | null {
  let userPath = typeof raw.path === "string" ? raw.path : "";
  if (!userPath) userPath = Bun.env.OMP_NOTIFY_FILE_PATH ?? "";
  if (!userPath) return null;

  // 1. Resolve against workspace root, validate containment
  const resolved = path.resolve(workspaceRoot, userPath);
  if (!resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot) {
    logger.warn("Notification file path escapes workspace", { path: userPath });
    return null;
  }

  // 2. Template variable validation happens at dispatch time:
  //    {{name}} must not contain /, \, or ..

  return {
    type: "file",
    path: resolved,
    mode: raw.mode === "overwrite" ? "overwrite" : "append",
    label: typeof raw.label === "string" ? raw.label : path.basename(resolved),
  };
}
```
