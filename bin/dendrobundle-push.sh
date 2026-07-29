#!/usr/bin/env bash
# Upload a bundle-stats file (esbuild metafile from tsup) to DendroBundle.
# Non-blocking by design: missing token or stats file exits 0 so tracking can
# never fail a build or release.
set -euo pipefail

file="${1:-}"
if [[ -z "$file" ]]; then
  echo "usage: bin/dendrobundle-push.sh <stats-file.json>" >&2
  exit 2
fi

token="${DENDROBUNDLE_TOKEN:-}"

if [[ -z "$token" ]]; then
  echo "[dendrobundle] DENDROBUNDLE_TOKEN not set; skipping upload" >&2
  exit 0
fi

if [[ ! -f "$file" ]]; then
  echo "[dendrobundle] stats file not found: $file; skipping upload" >&2
  exit 0
fi

url="${DENDROBUNDLE_URL:-https://dendrobundle.com}"
commit="${COMMIT_SHA:-${GITHUB_SHA:-}}"
branch="${BRANCH:-${GITHUB_REF_NAME:-}}"

if [[ -z "$commit" ]]; then
  commit="$(git rev-parse HEAD 2>/dev/null || true)"
fi
if [[ -z "$branch" ]]; then
  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
fi

uri_encode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1] ?? ""))' "$1"
}

endpoint="$url/api/push?commit=$(uri_encode "$commit")&branch=$(uri_encode "$branch")"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
gzip -c "$file" > "$tmp"

echo "[dendrobundle] pushing $file branch=$branch commit=$commit"
response="$({
  curl -sS -w '\n%{http_code}' "$endpoint" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -H "Content-Encoding: gzip" \
    --data-binary "@$tmp"
} || true)"

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" == "409" ]]; then
  echo "[dendrobundle] upload skipped: snapshot already exists for branch=$branch commit=$commit"
  exit 0
fi

if [[ "$status" != "200" ]]; then
  echo "[dendrobundle] upload failed ($status): $body" >&2
  exit 1
fi

echo "[dendrobundle] upload ok: $body"
