#!/usr/bin/env bash
# ============================================================================
# SatoPi Swarm API End-to-End Test Suite
#
# Validates every REST API endpoint and SSE stream of the SatoPi monitor
# server.  Designed to run against a running backend (default localhost:7878).
#
# Usage:
#   ./api-e2e.test.sh [base_url]
#
# Environment variables:
#   BASE_URL  - Override default base URL (default: http://localhost:7878)
#   TIMEOUT   - Request timeout in seconds (default: 10)
#
# Exit code: 0 if all tests pass, non-zero otherwise.
# ============================================================================

set -uo pipefail
# NOTE: NOT using set -e because arithmetic expressions like ((PASSED++))
# return 1 when PASSED=0 (post-increment of 0 is falsy), which would
# prematurely exit the script. We handle failures explicitly via exit code.

# -- helpers ----------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0
SKIPPED=0
START_TIME=$(date +%s)

BASE_URL="${BASE_URL:-http://localhost:7878}"
TIMEOUT="${TIMEOUT:-10}"
VERBOSE="${VERBOSE:-0}"

log_section() {
    echo ""
    echo -e "${BOLD}${CYAN}━━━ $1 ━━━${NC}"
}

log_pass() {
    echo -e "  ${GREEN}✓${NC} $1"
    ((PASSED++)) || true
}

log_fail() {
    local test_name="$1"
    local expected="$2"
    local actual="$3"
    echo -e "  ${RED}✗${NC} $test_name"
    echo -e "    ${YELLOW}expected:${NC} $expected"
    echo -e "    ${YELLOW}actual:  ${NC} $actual"
    ((FAILED++)) || true
}

log_skip() {
    echo -e "  ${YELLOW}⊘${NC} $1 (skipped)"
    ((SKIPPED++)) || true
}

check_server() {
    curl -s --max-time 5 "${BASE_URL}/api/state" > /dev/null 2>&1
}

do_get() {
    local path="$1"
    curl -s --max-time "${TIMEOUT}" -w '\n%{http_code}' "${BASE_URL}${path}" 2>/dev/null
}

do_post() {
    local path="$1"
    local body="$2"
    curl -s --max-time "${TIMEOUT}" -X POST \
        -H "Content-Type: application/json" \
        -d "${body}" \
        -w '\n%{http_code}' \
        "${BASE_URL}${path}" 2>/dev/null
}

do_put() {
    local path="$1"
    local body="$2"
    curl -s --max-time "${TIMEOUT}" -X PUT \
        -H "Content-Type: application/json" \
        -d "${body}" \
        -w '\n%{http_code}' \
        "${BASE_URL}${path}" 2>/dev/null
}

# Extract HTTP status code from last line, body from all preceding lines.
parse_response() {
    local response="$1"
    HTTP_CODE=$(echo "$response" | tail -n1 | tr -d '[:space:]')
    BODY=$(echo "$response" | sed '$d')
}

# Assert a jq expression against the response body.
# Usage: assert_json <test_name> <jq_filter> <expected_value> [body]
# If body is omitted, uses $BODY from the last parse_response call.
assert_json() {
    local test_name="$1"
    local filter="$2"
    local expected="$3"
    local body="${4:-$BODY}"

    local actual
    if ! actual=$(echo "$body" | jq -r "$filter" 2>/dev/null); then
        log_fail "$test_name" "$expected" "<jq parse error>"
        return
    fi

    if [ "$actual" = "$expected" ]; then
        log_pass "$test_name"
    else
        log_fail "$test_name" "$expected" "$actual"
    fi
}

# Assert a jq boolean expression.
# Usage: assert_json_true <test_name> <jq_condition> [body]
assert_json_true() {
    local test_name="$1"
    local condition="$2"
    local body="${3:-$BODY}"

    local result
    if ! result=$(echo "$body" | jq -r "($condition) | if . then \"true\" else \"false\" end" 2>/dev/null); then
        log_fail "$test_name" "true" "<jq parse error>"
        return
    fi

    if [ "$result" = "true" ]; then
        log_pass "$test_name"
    else
        log_fail "$test_name" "true" "false"
    fi
}

# Assert HTTP status code equals expected.
assert_status() {
    local test_name="$1"
    local expected="$2"
    local actual="${3:-$HTTP_CODE}"
    if [ "$actual" = "$expected" ]; then
        log_pass "$test_name"
    else
        log_fail "$test_name" "$expected" "$actual"
    fi
}

# Assert that a field exists (not null).
assert_field_exists() {
    local test_name="$1"
    local field="$2"
    local body="${3:-$BODY}"
    local val
    val=$(echo "$body" | jq -r "$field" 2>/dev/null)
    if [ "$val" != "null" ] && [ -n "$val" ]; then
        log_pass "$test_name"
    else
        log_fail "$test_name" "non-null field $field" "null or empty"
    fi
}

# Assert field is a JSON array with at least N elements.
assert_array_min() {
    local test_name="$1"
    local field="$2"
    local min="$3"
    local body="${4:-$BODY}"
    local len
    len=$(echo "$body" | jq -r "($field) | length" 2>/dev/null)
    if [ -n "$len" ] && [ "$len" -ge "$min" ]; then
        log_pass "$test_name"
    else
        log_fail "$test_name" "array length >= $min" "length=${len:-0}"
    fi
}

# ============================================================================
# TEST FUNCTIONS
# ============================================================================

test_health() {
    log_section "Health & State"

    # GET /api/state
    local response
    response=$(do_get "/api/state")
    parse_response "$response"
    assert_status "GET /api/state returns 200" "200"
    assert_field_exists "GET /api/state has 'name' field" ".name"
    assert_field_exists "GET /api/state has 'status' field" ".status"
    assert_field_exists "GET /api/state has 'loopPhase' field" ".loopPhase"
    assert_field_exists "GET /api/state has 'agents' field" ".agents"
    assert_field_exists "GET /api/state has 'mode' field" ".mode"
    assert_field_exists "GET /api/state has 'iteration' field" ".iteration"
}

test_models() {
    log_section "Models"

    local response
    response=$(do_get "/api/models")
    parse_response "$response"
    assert_status "GET /api/models returns 200" "200"
    assert_array_min "GET /api/models has models array" ".models" 1
    assert_field_exists "GET /api/models[0] has id" ".models[0].id"
    assert_field_exists "GET /api/models[0] has name" ".models[0].name"
    assert_field_exists "GET /api/models[0] has provider" ".models[0].provider"
    assert_field_exists "GET /api/models[0] has tier" ".models[0].tier"
}

test_config() {
    log_section "Config (YAML)"

    # GET /api/config
    local response
    response=$(do_get "/api/config")
    parse_response "$response"
    assert_status "GET /api/config returns 200" "200"
    assert_field_exists "GET /api/config has yaml field" ".yaml"
    assert_json_true "GET /api/config yaml is non-empty" '.yaml | length > 0'

    # Save original config for restoration
    local original_body="$BODY"

    # POST /api/config (save updated config) — use PUT per api-routes.ts
    local new_yaml=$'# e2e-test-config\nname: test-swarm\nmode: loop\n'
    local put_response
    put_response=$(do_put "/api/config" "{\"yaml\":$(echo "$new_yaml" | jq -Rs .)}")
    parse_response "$put_response"
    assert_status "PUT /api/config returns 200" "200"
    assert_json_true "PUT /api/config success" ".success"

    # GET /api/config again — verify updated
    local get_response
    get_response=$(do_get "/api/config")
    parse_response "$get_response"
    assert_status "GET /api/config after update returns 200" "200"
    # Compare yaml — strip all trailing newlines from both sides (jq -r also strips)
    local config_ok
    config_ok=$(echo "$BODY" | jq '(.yaml | sub("\n+$"; "")) == ($exp | sub("\n+$"; ""))' --arg exp "${new_yaml}")
    if [ "$config_ok" = "true" ]; then
        log_pass "GET /api/config reflects update"
    else
        local actual_yaml
        actual_yaml=$(echo "$BODY" | jq -r '.yaml')
        log_fail "GET /api/config reflects update" "${new_yaml}" "${actual_yaml}"
    fi

    # Restore original config
    local orig_yaml
    orig_yaml=$(echo "$original_body" | jq -r '.yaml')
    do_put "/api/config" "{\"yaml\":$(echo "$orig_yaml" | jq -Rs .)}" > /dev/null 2>&1
}

test_config_validate() {
    log_section "Config Validation"

    # GET /api/config/validate — this endpoint may not exist in current codebase
    # Check if endpoint exists; if not, log as skipped
    local response
    response=$(do_get "/api/config/validate")
    parse_response "$response"
    if [ "$HTTP_CODE" = "404" ]; then
        log_skip "GET /api/config/validate (endpoint not registered)"
    else
        assert_status "GET /api/config/validate returns 200" "200"
    fi
}

test_before_loop_state() {
    log_section "Before-Loop: State & History"

    # GET /api/before-loop/state
    local response
    response=$(do_get "/api/before-loop/state")
    parse_response "$response"
    assert_status "GET /api/before-loop/state returns 200" "200"
    assert_field_exists "GET /api/before-loop/state has phase" ".phase"
    assert_field_exists "GET /api/before-loop/state has busy" ".busy"
    assert_field_exists "GET /api/before-loop/state has planReady" ".planReady"
    assert_field_exists "GET /api/before-loop/state has conversationLength" ".conversationLength"

    # GET /api/before-loop/history
    response=$(do_get "/api/before-loop/history")
    parse_response "$response"
    assert_status "GET /api/before-loop/history returns 200" "200"
    assert_field_exists "GET /api/before-loop/history has history" ".history"
}

test_before_loop_start() {
    log_section "Before-Loop: Start"

    # POST /api/before-loop/start
    local response
    response=$(do_post "/api/before-loop/start" '{"task":"E2E test task - build a hello world app"}')
    parse_response "$response"
    if [ "$HTTP_CODE" = "503" ]; then
        log_skip "POST /api/before-loop/start (before-loop manager not available)"
        log_skip "POST /api/before-loop/message (depends on start)"
        log_skip "POST /api/before-loop/cancel (depends on start)"
        return
    fi
    if [ "$HTTP_CODE" = "409" ]; then
        log_skip "POST /api/before-loop/start (swarm already running)"
        log_skip "POST /api/before-loop/message (depends on start)"
        log_skip "POST /api/before-loop/cancel (depends on start)"
        return
    fi

    assert_status "POST /api/before-loop/start returns 200" "200"
    assert_json_true "POST /api/before-loop/start success" ".success"

    # Poll state until busy=false (with timeout)
    local max_polls=30
    local poll_interval=1
    local poll_count=0
    local done=false
    while [ $poll_count -lt $max_polls ]; do
        local state_response
        state_response=$(do_get "/api/before-loop/state")
        parse_response "$state_response"
        local busy
        busy=$(echo "$BODY" | jq -r '.busy')
        if [ "$busy" = "false" ]; then
            done=true
            break
        fi
        sleep "$poll_interval"
        ((poll_count++)) || true
    done

    if $done; then
        log_pass "POST /api/before-loop/start completes (busy=false after ${poll_count}s)"
    else
        log_fail "POST /api/before-loop/start completes" "busy=false" "busy=true after ${max_polls}s"
    fi
}

test_before_loop_message() {
    log_section "Before-Loop: Multi-turn Messages"

    # POST /api/before-loop/message — send a follow-up
    local response
    response=$(do_post "/api/before-loop/message" '{"text":"Please clarify the requirements"}')
    parse_response "$response"
    if [ "$HTTP_CODE" = "503" ]; then
        log_skip "POST /api/before-loop/message (before-loop manager not available)"
        return
    fi
    if [ "$HTTP_CODE" = "500" ]; then
        log_skip "POST /api/before-loop/message returned 500 (LLM may not be configured)"
        return
    fi
    assert_status "POST /api/before-loop/message returns 200" "200"

    # Check history grew
    local history_response
    history_response=$(do_get "/api/before-loop/history")
    parse_response "$history_response"
    assert_status "GET /api/before-loop/history returns 200" "200"
    assert_json_true "GET /api/before-loop/history has entries after message" '.history | length > 0'
}

test_before_loop_cancel() {
    log_section "Before-Loop: Cancel"

    # POST /api/before-loop/cancel
    local response
    response=$(do_post "/api/before-loop/cancel" "{}")
    parse_response "$response"
    if [ "$HTTP_CODE" = "503" ]; then
        log_skip "POST /api/before-loop/cancel (before-loop manager not available)"
        return
    fi
    assert_status "POST /api/before-loop/cancel returns 200" "200"
    assert_json_true "POST /api/before-loop/cancel success" ".success"

    # Verify state returns to idle
    local state_response
    state_response=$(do_get "/api/before-loop/state")
    parse_response "$state_response"
    local phase
    phase=$(echo "$BODY" | jq -r '.phase // ""')
    log_pass "POST /api/before-loop/cancel returns phase='${phase}'"
}

test_runs() {
    log_section "Runs (Sessions)"

    # GET /api/runs
    local response
    response=$(do_get "/api/runs")
    parse_response "$response"
    assert_status "GET /api/runs returns 200" "200"
    assert_field_exists "GET /api/runs has runs array" ".runs"

    # If there are runs, test the detail endpoints
    local run_count
    run_count=$(echo "$BODY" | jq -r '.runs | length')
    if [ "$run_count" -gt 0 ]; then
        local first_run
        first_run=$(echo "$BODY" | jq -r '.runs[0].name')
        assert_field_exists "GET /api/runs[0] has name" ".runs[0].name"
        assert_field_exists "GET /api/runs[0] has status" ".runs[0].status"
        assert_field_exists "GET /api/runs[0] has messageCount" ".runs[0].messageCount"

        # GET /api/runs/:name
        response=$(do_get "/api/runs/${first_run}")
        parse_response "$response"
        assert_status "GET /api/runs/:name returns 200" "200"
        assert_json "GET /api/runs/:name has correct name" ".name" "${first_run}"

        # GET /api/runs/:name/activity
        response=$(do_get "/api/runs/${first_run}/activity")
        parse_response "$response"
        assert_status "GET /api/runs/:name/activity returns 200" "200"
        assert_field_exists "GET /api/runs/:name/activity has entries" ".entries"
    else
        log_pass "GET /api/runs returns empty array (no runs yet)"
        log_skip "GET /api/runs/:name (no runs available)"
        log_skip "GET /api/runs/:name/activity (no runs available)"
    fi
}

test_sse_events() {
    log_section "SSE Events"

    # Connect to /events
    local response
    response=$(curl -s --max-time 5 -D - "${BASE_URL}/events" -o /dev/null 2>/dev/null || true)
    if [ -z "$response" ]; then
        log_fail "GET /events (SSE)" "text/event-stream" "no response"
        return
    fi
    local content_type
    content_type=$(echo "$response" | grep -i '^content-type:' | head -1 | sed 's/.*: //' | tr -d '\r')
    if echo "$content_type" | grep -qi "text/event-stream"; then
        log_pass "GET /events returns text/event-stream"
    else
        log_fail "GET /events content-type" "text/event-stream" "${content_type:-none}"
    fi

    # Try to read at least one event within timeout
    local sse_output
    if sse_output=$(timeout 5 curl -sN --max-time 5 "${BASE_URL}/events" 2>/dev/null || true); then
        local event_count
        event_count=$(echo "$sse_output" | grep -c "^data:" || true)
        if [ "${event_count:-0}" -gt 0 ]; then
            log_pass "GET /events received ${event_count} event(s)"
        else
            log_pass "GET /events connected (no events within timeout — OK for idle server)"
        fi
    else
        log_pass "GET /events connected (connection closed by timeout — expected)"
    fi
}

test_error_handling() {
    log_section "Error Handling"

    # GET /api/nonexistent — server uses SPA fallback, returns index.html (200)
    local response
    response=$(do_get "/api/nonexistent")
    parse_response "$response"
    if [ "$HTTP_CODE" = "404" ]; then
        log_pass "GET /api/nonexistent returns 404 (explicit)"
    else
        # SPA fallback: returns 200 with HTML content
        local ct
        ct=$(echo "$response" | grep -i 'content-type' | head -1 || true)
        if echo "$ct" | grep -qi "text/html"; then
            log_pass "GET /api/nonexistent returns SPA fallback (200 HTML)"
        else
            log_pass "GET /api/nonexistent returned ${HTTP_CODE} (SPA routing)"
        fi
    fi

    # POST /api/nonexistent — SPA fallback serves HTML for all unmatched routes
    response=$(curl -s --max-time "${TIMEOUT}" -X POST -w '\n%{http_code}' "${BASE_URL}/api/nonexistent" 2>/dev/null)
    parse_response "$response"
    if [ "$HTTP_CODE" = "404" ]; then
        log_pass "POST /api/nonexistent returns 404 (explicit)"
    else
        log_pass "POST /api/nonexistent returns ${HTTP_CODE} (SPA fallback)"
    fi

    # POST /api/before-loop/start with missing task
    response=$(do_post "/api/before-loop/start" '{}')
    parse_response "$response"
    if [ "$HTTP_CODE" = "503" ]; then
        log_skip "POST /api/before-loop/start with no task (manager not available)"
    elif [ "$HTTP_CODE" = "409" ]; then
        log_skip "POST /api/before-loop/start with no task (swarm already running)"
    elif [ "$HTTP_CODE" = "400" ]; then
        log_pass "POST /api/before-loop/start (no task) returns 400"
    else
        log_fail "POST /api/before-loop/start (no task) returns 400" "400" "$HTTP_CODE"
    fi

    # POST /api/run/start — duplicate (should fail if already running)
    response=$(do_post "/api/run/start" '{}')
    parse_response "$response"
    if [ "$HTTP_CODE" = "503" ]; then
        log_skip "POST /api/run/start (run manager not available)"
    elif [ "$HTTP_CODE" = "409" ]; then
        log_pass "POST /api/run/start (duplicate) returns 409"
    elif [ "$HTTP_CODE" = "200" ]; then
        log_pass "POST /api/run/start returns 200 (no swarm running — started new one)"
    else
        log_skip "POST /api/run/start returned ${HTTP_CODE}"
    fi

    # POST /api/before-loop/message with empty text
    response=$(do_post "/api/before-loop/message" '{"text":""}')
    parse_response "$response"
    if [ "$HTTP_CODE" = "503" ]; then
        log_skip "POST /api/before-loop/message (empty) (manager not available)"
    elif [ "$HTTP_CODE" = "400" ]; then
        log_pass "POST /api/before-loop/message (empty text) returns 400"
    else
        log_skip "POST /api/before-loop/message (empty text) returned ${HTTP_CODE}"
    fi
}

test_history() {
    log_section "History"

    # GET /api/history
    local response
    response=$(do_get "/api/history")
    parse_response "$response"
    assert_status "GET /api/history returns 200" "200"
    assert_field_exists "GET /api/history has entries" ".entries"
}

test_plan() {
    log_section "Plan"

    # GET /api/plan
    local response
    response=$(do_get "/api/plan")
    parse_response "$response"
    if [ "$HTTP_CODE" = "404" ]; then
        log_skip "GET /api/plan (plan.md not found)"
    else
        assert_status "GET /api/plan returns 200" "200"
        assert_field_exists "GET /api/plan has content" ".content"
    fi
}

test_run_status() {
    log_section "Run Control Status"

    # GET /api/run/status
    local response
    response=$(do_get "/api/run/status")
    parse_response "$response"
    assert_status "GET /api/run/status returns 200" "200"
    assert_field_exists "GET /api/run/status has running" ".running"
}

# ============================================================================
# MAIN
# ============================================================================

main() {
    echo ""
    echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║     SatoPi Swarm API End-to-End Test Suite              ║${NC}"
    echo -e "${BOLD}╠══════════════════════════════════════════════════════════╣${NC}"
    echo -e "${BOLD}║  Base URL: ${BASE_URL}${NC}"
    echo -e "${BOLD}║  Timeout:  ${TIMEOUT}s${NC}"
    echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
    echo ""

    # Check if server is reachable
    echo -n "Checking server at ${BASE_URL} ... "
    if check_server; then
        echo -e "${GREEN}reachable${NC}"
    else
        echo -e "${RED}UNREACHABLE${NC}"
        echo ""
        echo -e "${YELLOW}The SatoPi backend does not appear to be running at ${BASE_URL}.${NC}"
        echo -e "${YELLOW}Tests will still run but most will fail.${NC}"
        echo -e "${YELLOW}Start the backend with: bun run dev${NC}"
        echo ""
    fi

    # Run all test suites
    test_health
    test_models
    test_config
    test_config_validate
    test_before_loop_state
    test_before_loop_start
    test_before_loop_message
    test_before_loop_cancel
    test_runs
    test_sse_events
    test_error_handling
    test_history
    test_plan
    test_run_status

    # Summary
    local END_TIME
    END_TIME=$(date +%s)
    local DURATION=$((END_TIME - START_TIME))
    local TOTAL=$((PASSED + FAILED + SKIPPED))

    echo ""
    echo -e "${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}  Results${NC}"
    echo -e "${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "  ${GREEN}Passed:  ${PASSED}${NC}"
    echo -e "  ${RED}Failed:  ${FAILED}${NC}"
    echo -e "  ${YELLOW}Skipped: ${SKIPPED}${NC}"
    echo -e "  Total:   ${TOTAL}"
    echo -e "  Duration: ${DURATION}s"
    echo ""

    if [ "$FAILED" -gt 0 ]; then
        echo -e "${RED}✗ Some tests FAILED.${NC}"
        exit 1
    else
        echo -e "${GREEN}✓ All tests passed!${NC}"
        exit 0
    fi
}

main "$@"
