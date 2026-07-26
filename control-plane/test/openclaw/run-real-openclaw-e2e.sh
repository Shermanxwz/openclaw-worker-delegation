#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="${GITHUB_WORKSPACE:-$(cd "$(dirname "$0")/../../.." && pwd)}"
CONTROL="$ROOT/control-plane"
TMP="${RUNNER_TEMP:-/tmp}/ocwd-real-openclaw"
STATE="$TMP/state"
CONFIG="$STATE/openclaw.json"
LOGS="$TMP/logs"
MARKERS="$TMP/markers"
WORKSPACES="$TMP/workspaces"
GATEWAY_PORT=18789
MODEL_PORT=4000
CONTROLLER_PORT=8787
GATEWAY_TOKEN="gateway-e2e-token-$(printf x%.0s {1..32})"
AGENT_TOKEN="agent-e2e-token-$(printf y%.0s {1..40})"
export OPENCLAW_STATE_DIR="$STATE"
export OPENCLAW_CONFIG_PATH="$CONFIG"
export OPENCLAW_GATEWAY_TOKEN="$GATEWAY_TOKEN"
export OCWD_AGENT_TOKEN="$AGENT_TOKEN"
export MOCK_MARKER_DIR="$MARKERS"
export MOCK_OPENAI_PORT="$MODEL_PORT"
export NODE_ENV=test
export HOST=127.0.0.1
export PORT="$CONTROLLER_PORT"
export DATA_DIR="$TMP/controller-data"
export DEV_INSECURE=true
export AGENT_INGEST_TOKEN="$AGENT_TOKEN"
export MAIN_AGENT_IDS=main
export WORKER_AGENT_IDS=body-worker
export VERIFIER_AGENT_IDS=verifier
export DEFAULT_MODE=auto
export COOKIE_SECURE=false
export AUDIT_ALLOWED_TOOLS=true

mkdir -p "$STATE" "$LOGS" "$MARKERS" "$WORKSPACES/main" "$WORKSPACES/worker" "$WORKSPACES/verifier" "$DATA_DIR"
chmod 700 "$STATE" "$DATA_DIR"

MOCK_PID=""; CONTROL_PID=""; GATEWAY_PID=""
cleanup() {
  set +e
  [[ -n "$GATEWAY_PID" ]] && kill "$GATEWAY_PID" 2>/dev/null
  [[ -n "$CONTROL_PID" ]] && kill "$CONTROL_PID" 2>/dev/null
  [[ -n "$MOCK_PID" ]] && kill "$MOCK_PID" 2>/dev/null
  wait "$GATEWAY_PID" "$CONTROL_PID" "$MOCK_PID" 2>/dev/null
}
show_logs() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    echo "===== FAILURE DIAGNOSTICS ====="
    for file in "$LOGS"/*.log "$MARKERS"/*.ndjson; do
      [[ -f "$file" ]] || continue
      echo "--- $file ---"
      tail -n 300 "$file" || true
    done
    echo "--- active config (tokens redacted) ---"
    sed -E 's/(token|apiKey)"?: *"[^"]+"/\1":"[redacted]"/g' "$CONFIG" 2>/dev/null || true
    echo "--- controller events ---"
    tail -n 300 "$DATA_DIR/events.ndjson" 2>/dev/null || true
  fi
  cleanup
  exit "$status"
}
trap show_logs EXIT

cat > "$CONFIG" <<JSON
{
  "gateway": {
    "mode": "local",
    "port": $GATEWAY_PORT,
    "bind": "loopback",
    "auth": { "mode": "token", "token": "$GATEWAY_TOKEN" },
    "controlUi": { "enabled": false },
    "tailscale": { "mode": "off" }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "mock": {
        "baseUrl": "http://127.0.0.1:$MODEL_PORT/v1",
        "apiKey": "mock-api-key",
        "api": "openai-completions",
        "models": [{
          "id": "mock-model",
          "name": "OCWD E2E Mock",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 128000,
          "contextTokens": 96000,
          "maxTokens": 4096
        }]
      }
    }
  },
  "tools": {
    "profile": "coding",
    "exec": { "mode": "full" }
  },
  "agents": {
    "defaults": {
      "model": "mock/mock-model",
      "subagents": {
        "maxConcurrent": 4,
        "runTimeoutSeconds": 120,
        "requireAgentId": true
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "$WORKSPACES/main",
        "model": "mock/mock-model",
        "subagents": {
          "delegationMode": "prefer",
          "allowAgents": ["body-worker", "verifier"],
          "requireAgentId": true
        },
        "tools": { "profile": "coding" }
      },
      {
        "id": "body-worker",
        "workspace": "$WORKSPACES/worker",
        "model": "mock/mock-model",
        "sandbox": { "mode": "off" },
        "tools": {
          "profile": "coding",
          "deny": ["gateway", "cron", "message", "sessions_spawn"],
          "elevated": { "enabled": false }
        }
      },
      {
        "id": "verifier",
        "workspace": "$WORKSPACES/verifier",
        "model": "mock/mock-model",
        "sandbox": { "mode": "off" },
        "tools": {
          "allow": ["read", "web_search", "web_fetch", "session_status"],
          "deny": ["group:runtime", "write", "edit", "apply_patch"],
          "elevated": { "enabled": false }
        }
      }
    ]
  }
}
JSON

assert_file_exists() { [[ -f "$1" ]] || { echo "Expected file missing: $1" >&2; return 1; }; }
assert_file_absent() { [[ ! -e "$1" ]] || { echo "Unexpected file exists: $1" >&2; return 1; }; }
wait_file() {
  local file="$1" timeout="${2:-30}"
  for ((i=0; i<timeout*5; i++)); do [[ -e "$file" ]] && return 0; sleep .2; done
  echo "Timed out waiting for $file" >&2; return 1
}
wait_http() {
  local url="$1" timeout="${2:-60}"
  for ((i=0; i<timeout*5; i++)); do curl -fsS "$url" >/dev/null 2>&1 && return 0; sleep .2; done
  echo "Timed out waiting for $url" >&2; return 1
}
json_assert() {
  local file="$1" expression="$2"
  node - "$file" "$expression" <<'NODE'
const fs = require('fs');
const [file, expression] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!Function('value', `return Boolean(${expression})`)(value)) {
  console.error('JSON assertion failed:', expression, JSON.stringify(value, null, 2));
  process.exit(1);
}
NODE
}
run_agent() {
  local session="$1" marker="$2" output="$3"
  openclaw agent --agent main --session-id "$session" --message "$marker" --json >"$output" 2>"${output%.json}.stderr.log"
}

printf 'OpenClaw version: '; openclaw --version
printf 'Node version: '; node --version

node "$CONTROL/test/openclaw/mock-openai-server.mjs" >"$LOGS/mock.log" 2>&1 & MOCK_PID=$!
wait_http "http://127.0.0.1:$MODEL_PORT/v1/models" 30

node "$CONTROL/src/server.mjs" >"$LOGS/controller.log" 2>&1 & CONTROL_PID=$!
wait_http "http://127.0.0.1:$CONTROLLER_PORT/health/ready" 30

openclaw config validate --json 2>&1 | tee "$LOGS/config-before-plugin.json"
(cd "$CONTROL/openclaw-plugin" && openclaw plugins install --link .) 2>&1 | tee "$LOGS/plugin-install.log"
openclaw plugins enable delegation-guard 2>&1 | tee "$LOGS/plugin-enable.log"

node <<'NODE'
const fs = require('fs');
const file = process.env.OPENCLAW_CONFIG_PATH;
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.plugins ||= {};
config.plugins.entries ||= {};
config.plugins.entries['delegation-guard'] = {
  enabled: true,
  hooks: {
    allowPromptInjection: true,
    timeouts: { before_prompt_build: 5000, before_tool_call: 5000 }
  },
  config: {
    controllerUrl: 'http://127.0.0.1:8787',
    tokenEnv: 'OCWD_AGENT_TOKEN',
    failMode: 'closed',
    requestTimeoutMs: 2500,
    heartbeatSeconds: 10,
    mainAgentIds: ['main'],
    workerAgentIds: ['body-worker'],
    verifierAgentIds: ['verifier']
  }
};
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
NODE

openclaw config validate --json 2>&1 | tee "$LOGS/config-after-plugin.json"
openclaw plugins inspect delegation-guard --runtime --json 2>&1 | tee "$LOGS/plugin-runtime-inspect.json"
grep -q 'before_prompt_build' "$LOGS/plugin-runtime-inspect.json"
grep -q 'before_tool_call' "$LOGS/plugin-runtime-inspect.json"

openclaw gateway --port "$GATEWAY_PORT" --verbose >"$LOGS/gateway.log" 2>&1 & GATEWAY_PID=$!
for ((i=0; i<300; i++)); do
  if openclaw gateway health --port "$GATEWAY_PORT" >"$LOGS/gateway-health.log" 2>&1; then break; fi
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then echo "Gateway exited" >&2; exit 1; fi
  sleep .2
done
openclaw gateway health --port "$GATEWAY_PORT" | tee "$LOGS/gateway-health-final.log"

COOKIE="$TMP/cookies.txt"
LOGIN="$TMP/login.json"
curl -fsS -c "$COOKIE" -H 'content-type: application/json' -d '{"password":"e2e"}' "http://127.0.0.1:$CONTROLLER_PORT/api/login" > "$LOGIN"
CSRF="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1])).csrfToken" "$LOGIN")"
mode() {
  local scope="$1" id="$2" selected="$3" ttl="${4:-15}"
  local body
  if [[ "$selected" == main ]]; then
    body="{\"scope\":\"$scope\",\"id\":\"$id\",\"mode\":\"main\",\"confirmation\":\"ENABLE_MAIN\",\"reauthPassword\":\"e2e\",\"ttlMinutes\":$ttl}"
  else
    body="{\"scope\":\"$scope\",\"id\":\"$id\",\"mode\":\"$selected\",\"ttlMinutes\":$ttl}"
  fi
  curl -fsS -b "$COOKIE" -H 'content-type: application/json' -H "x-csrf-token: $CSRF" -X PUT -d "$body" "http://127.0.0.1:$CONTROLLER_PORT/api/mode"
}

# Auto: mutation/exec prompt must be routed to Worker, so Main's exec call is blocked.
mode global '' auto > "$LOGS/mode-auto.json"
run_agent "11111111-1111-4111-8111-111111111111" OCWD_BLOCK_MAIN_EXEC "$LOGS/auto-block.json" || true
assert_file_absent "$MARKERS/main-block-bad"
grep -q 'tool.blocked' "$DATA_DIR/events.ndjson"
grep -q '"role":"main"' "$DATA_DIR/events.ndjson"

# Worker mode: Main may spawn a real body-worker, whose real exec is allowed.
mode global '' worker > "$LOGS/mode-worker.json"
run_agent "22222222-2222-4222-8222-222222222222" OCWD_SPAWN_WORKER "$LOGS/worker-spawn.json"
wait_file "$MARKERS/worker-exec-ok" 45
assert_file_exists "$MARKERS/worker-exec-ok"

# Main mode: Main exec is allowed and an existing Worker is frozen after switch.
mode global '' main 15 > "$LOGS/mode-main.json"
run_agent "33333333-3333-4333-8333-33333333333" OCWD_ALLOW_MAIN_EXEC "$LOGS/main-allow.json"
assert_file_exists "$MARKERS/main-exec-ok"

mode global '' worker > "$LOGS/mode-worker-freeze.json"
run_agent "44444444-4444-4444-8444-444444444444" OCWD_SPAWN_DELAYED_WORKER "$LOGS/delayed-spawn.json" & DELAY_AGENT_PID=$!
wait_file "$MARKERS/worker-model-requested" 45
mode global '' main 15 > "$LOGS/mode-main-freeze.json"
wait "$DELAY_AGENT_PID" || true
sleep 9
assert_file_absent "$MARKERS/worker-delayed-exec"
grep -q '"role":"worker"' "$DATA_DIR/events.ndjson"

# One-shot Main override is consumed for exactly one real run in a Worker session.
mode global '' worker > "$LOGS/mode-worker-oneshot.json"
ONE_SESSION="55555555-5555-4555-8555-555555555555"
mode task "$ONE_SESSION" main 15 > "$LOGS/mode-task-main.json"
run_agent "$ONE_SESSION" OCWD_ONE_SHOT_MAIN "$LOGS/one-shot-first.json"
assert_file_exists "$MARKERS/one-shot-main-ok"
run_agent "$ONE_SESSION" OCWD_ONE_SHOT_SECOND "$LOGS/one-shot-second.json" || true
assert_file_absent "$MARKERS/one-shot-second-bad"

# The real plugin must report models and earn HARD only through observed hooks.
curl -fsS -b "$COOKIE" "http://127.0.0.1:$CONTROLLER_PORT/api/status?sessionId=$ONE_SESSION" > "$LOGS/controller-status.json"
json_assert "$LOGS/controller-status.json" 'value.runtimeStatus.enforcement.hard === true'
json_assert "$LOGS/controller-status.json" 'String(value.runtimeStatus.main.model || "").includes("mock-model")'
json_assert "$LOGS/controller-status.json" 'Array.isArray(value.runtimeStatus.workers) && value.runtimeStatus.workers.some(w => String(w.model || "").includes("mock-model"))'

# Controller loss: even Main mode must block every tool in fail-closed mode.
mode global '' main 15 > "$LOGS/mode-main-offline.json"
kill "$CONTROL_PID"; wait "$CONTROL_PID" || true; CONTROL_PID=""
run_agent "66666666-6666-4666-8666-666666666666" OCWD_OFFLINE_EXEC "$LOGS/offline-exec.json" || true
assert_file_absent "$MARKERS/offline-exec-bad"

cat > "$LOGS/summary.json" <<JSON
{
  "openclawVersion": "$(openclaw --version | tr -d '\n' | sed 's/"/\\"/g')",
  "nodeVersion": "$(node --version)",
  "pluginRuntimeHooks": true,
  "autoMainExecBlocked": true,
  "realWorkerSpawnAndExecAllowed": true,
  "mainExecAllowed": true,
  "existingWorkerFrozenInMain": true,
  "oneShotConsumedOnce": true,
  "hardProofReached": true,
  "realModelReporting": true,
  "controllerOfflineFullyFailClosed": true
}
JSON
cat "$LOGS/summary.json"
echo "REAL_OPENCLAW_E2E_PASS"
