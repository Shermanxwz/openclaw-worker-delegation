#!/usr/bin/env bash
set -euo pipefail

controller_url="${CONTROLLER_URL:-http://127.0.0.1:8787}"
plugin_id="${PLUGIN_ID:-delegation-guard}"

echo "== Controller readiness =="
curl --fail --silent --show-error "${controller_url}/health/ready"
echo

echo "== Controller configuration =="
node src/cli.mjs doctor

echo "== OpenClaw plugin runtime =="
if command -v openclaw >/dev/null 2>&1; then
  openclaw plugins inspect "${plugin_id}" --runtime --json
else
  echo "openclaw CLI not found; plugin runtime inspection skipped" >&2
  exit 2
fi
