#!/usr/bin/env bash
# Exercise the actual workflow shell with a fake HTTP client; no deployment.
set -euo pipefail
cd "$(dirname "$0")/.."
test_dir="$(mktemp -d)"
trap 'rm -f "$test_dir"/*; rmdir "$test_dir"' EXIT
export test_dir
target="${1:-web}"
case "$target" in web|api) ;; *) exit 1 ;; esac
sed -n '/^        run: |/,$p' .github/workflows/deploy-production-"$target".yml |
  tail -n +2 | sed 's/^          //' > "$test_dir/trigger.sh"

curl() {
  local output='' payload=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -o) output="$2"; shift ;;
      --data-binary) payload="${2#@}"; shift ;;
    esac
    shift
  done
  cp "$payload" "$test_dir/sent.json"
  printf '%s' "$MOCK_BODY" > "$output"
  printf '%s' "$MOCK_STATUS"
}
export -f curl
export CRON_SECRET='test-only' REF='refs/heads/main'
export REPOSITORY='Art-of-Technology/maestro-desk' SHA='0123456789abcdef'
export MOCK_STATUS=200 MOCK_BODY='{"ok":true}'
export GITHUB_EVENT_PATH="$test_dir/event.json"

for EVENT_NAME in push workflow_dispatch; do
  export EVENT_NAME
  # A real Actions push has no commit file lists; manual dispatch has no commits.
  if [ "$EVENT_NAME" = push ]; then
    printf '{"ref":"refs/heads/main","commits":[{"id":"%s"}]}' "$SHA" > "$GITHUB_EVENT_PATH"
  else
    printf '{}' > "$GITHUB_EVENT_PATH"
  fi
  bash "$test_dir/trigger.sh" > "$test_dir/result"
  jq -e --arg sha "$SHA" --arg prefix "$target/" '
    .ref == "refs/heads/main" and
    .repository.full_name == "Art-of-Technology/maestro-desk" and
    .head_commit.id == $sha and
    ([.commits[] | .added[], .modified[], .removed[]] | any(startswith($prefix)))
  ' "$test_dir/sent.json" > /dev/null
done

export MOCK_STATUS=502
for reason in 'Dokploy rejected the deployment.' 'Dokploy could not be reached.'; do
  export MOCK_BODY="{\"error\":\"$reason\"}"
  if bash "$test_dir/trigger.sh" > "$test_dir/result"; then exit 1; fi
  grep -Fq "::error::$reason" "$test_dir/result"
done
for MOCK_BODY in '{"error":"private-token-must-not-leak"}' '<html>private-token-must-not-leak</html>'; do
  export MOCK_BODY
  if bash "$test_dir/trigger.sh" > "$test_dir/result"; then exit 1; fi
  if grep -q 'private-token-must-not-leak' "$test_dir/result"; then exit 1; fi
done
echo 'Deployment workflow: push/manual payloads, failure reporting, and secret redaction passed.'
