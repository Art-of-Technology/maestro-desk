#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test_dir="$(mktemp -d)"
trap 'rm -f "$test_dir"/*; rmdir "$test_dir"' EXIT
sed -n '/^      - name: Call the endpoint/,$p' .github/workflows/cron-jobs.yml |
  sed -n '/^        run: |/,$p' | tail -n +2 | sed 's/^          //' | tr -d '\r' > "$test_dir/call.sh"
curl() {
  local output=''
  while [ "$#" -gt 0 ]; do
    if [ "$1" = '-o' ]; then output="$2"; shift; fi
    shift
  done
  printf '%s' "$MOCK_BODY" > "$output"
  printf '%s' "$MOCK_STATUS"
  return "$MOCK_EXIT"
}
export -f curl
export CRON_SECRET='test-only' JOB='retention' API_BASE='https://example.invalid'
export MOCK_STATUS=200 MOCK_EXIT=0
for MOCK_BODY in '{"ok":true}' '{"ok":true,"audit":{"tampered":0}}'; do
  export MOCK_BODY
  bash "$test_dir/call.sh" > "$test_dir/result"
done
for MOCK_BODY in '' 'private-body' '{}' 'null' '[]' '{"ok":"true"}' '{"ok":false}' '{"ok":true,"audit":{"tampered":1}}' '{"ok":true,"tamperedCount":2}' '{"ok":true} {}' '{"ok":true'; do
  export MOCK_BODY
  if bash "$test_dir/call.sh" > "$test_dir/result"; then echo 'Invalid response accepted'; exit 1; fi
  if grep -q 'private-body' "$test_dir/result"; then exit 1; fi
done
export MOCK_BODY='{"ok":true}' MOCK_EXIT=18
if bash "$test_dir/call.sh" > "$test_dir/result"; then exit 1; fi
export MOCK_EXIT=0 MOCK_STATUS=500
if bash "$test_dir/call.sh" > "$test_dir/result"; then exit 1; fi
echo 'Scheduled job response checks passed (offline).'
