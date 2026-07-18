# SatoPi Swarm API End-to-End Test Suite

Comprehensive end-to-end tests for the SatoPi Swarm Monitor HTTP API. Validates every REST endpoint and the SSE event stream.

## Test Files

| File | Runner | Location |
|------|--------|----------|
| `api-e2e.test.sh` | Bash + curl + jq | `tests/e2e/` |
| `api-e2e.bun.test.ts` | Bun test | `packages/swarm-gui/tests/e2e/` |

## Prerequisites

### Bash test
- `curl` (any modern version)
- `jq` (>= 1.6)

### Bun test
- Bun (>= 1.3.14, included in project)

Both tests require a running SatoPi backend on port 7878.

## Starting the Backend

```bash
# From the project root:
cd /root/workspace/SatoPi-e2e-tests

# Start the monitor server (it runs on port 7878 by default)
bun run dev
```

Wait for the server to start, then run the tests in another terminal.

## Running Tests

### Bash Test Suite

```bash
# Default: test against localhost:7878
./tests/e2e/api-e2e.test.sh

# Test against a custom URL
./tests/e2e/api-e2e.test.sh http://192.168.1.100:7878

# Or via environment variable
BASE_URL=http://localhost:7878 ./tests/e2e/api-e2e.test.sh

# Verbose mode
VERBOSE=1 ./tests/e2e/api-e2e.test.sh
```

### Bun Test Suite

```bash
# Run all e2e API tests
bun test packages/swarm-gui/tests/e2e/api-e2e.bun.test.ts

# With custom base URL
BASE_URL=http://localhost:7878 bun test packages/swarm-gui/tests/e2e/api-e2e.bun.test.ts

# From project root (bun test discovers *.test.ts)
cd /root/workspace/SatoPi-e2e-tests
bun test packages/swarm-gui/tests/e2e/api-e2e.bun.test.ts
```

## What's Tested

### Category 1: Health & State
- `GET /api/state` -- verifies structure (name, status, loopPhase, agents, mode, iteration, startedAt)
- `GET /api/run/status` -- verifies `running` boolean field

### Category 2: Models
- `GET /api/models` -- verifies non-empty models array, each with id/name/provider/tier

### Category 3: Config (YAML)
- `GET /api/config` -- verifies yaml string returned
- `PUT /api/config` -- verifies save + GET returns updated config
- Restores original config after update test

### Category 4: Before-Loop (Socrates dialog)
- `GET /api/before-loop/state` -- verifies structure (phase, busy, planReady, conversationLength)
- `POST /api/before-loop/start` -- verifies success, polls state until busy=false
- `GET /api/before-loop/history` -- verifies conversation array
- `POST /api/before-loop/message` -- verifies multi-turn conversation works
- `POST /api/before-loop/cancel` -- verifies returns to idle

### Category 5: Runs (Sessions)
- `GET /api/runs` -- verifies array, each with name/status/messageCount/lastActivity
- `GET /api/runs/:name` -- verifies single run metadata
- `GET /api/runs/:name/activity` -- verifies activity log exists

### Category 6: SSE Events
- `GET /events` -- verifies `text/event-stream` content-type
- Receives events within timeout

### Category 7: Error Handling
- `GET /api/nonexistent` -- verifies 404
- `POST /api/before-loop/start` with empty task -- verifies 400
- `POST /api/run/start` while running -- verifies 409
- `POST /api/before-loop/message` with empty text -- verifies 400

### Additional
- `GET /api/history` -- verifies entries array
- `GET /api/plan` -- verifies plan content or 404

## Output

Both test suites produce colorized output:

- **Green checkmarks** for passing tests
- **Red crosses** for failures (with expected vs actual)
- **Yellow** for skipped tests (when backend components are unavailable)

The bash test prints a summary at the end:

```
═══════════════════════════════════════════════════════════
  Results
═══════════════════════════════════════════════════════════
  Passed:  42
  Failed:  0
  Skipped: 3
  Total:   45
  Duration: 12s
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `http://localhost:7878` | SatoPi backend base URL |
| `TIMEOUT` | `10` (bash) / `10000` (bun) | Request timeout in seconds (bash) or ms (bun) |
| `VERBOSE` | `0` (bash only) | Set to 1 for verbose curl output |
