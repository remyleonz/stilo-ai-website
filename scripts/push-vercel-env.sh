#!/usr/bin/env bash
# ============================================================================
# push-vercel-env.sh
#
# Reads a local secrets JSON file and pushes every key/value as an env var to
# the Vercel project (production + preview + dev).
#
# Usage:
#   ./scripts/push-vercel-env.sh path/to/secrets.json
#   ./scripts/push-vercel-env.sh path/to/secrets.json --envs production,preview
#
# Format of secrets.json (gitignored):
#   {
#     "GOOGLE_OAUTH_CLIENT_ID": "8010...apps.googleusercontent.com",
#     "GOOGLE_OAUTH_CLIENT_SECRET": "GOCSPX-...",
#     "QUICKBOOKS_CLIENT_ID": "ABcd...",
#     ...
#   }
#
# Requires `vercel` CLI logged in (or VERCEL_TOKEN set). Run from inside
# sites/stilo-ai/ so vercel picks up the linked project.
#
# What it does for each key:
#   1. Removes any existing value (no-fail if absent) so we can re-push freshly.
#   2. Adds the value to production, preview, and development.
#
# Safety:
#   - Skips empty values.
#   - Skips keys whose value is the literal string "(not yet set)".
#   - Logs each action; on failure, exits non-zero.
# ============================================================================
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <secrets.json> [--envs production,preview,development]"
  exit 1
fi

SECRETS_FILE="$1"
ENVS="${3:-production,preview,development}"

if [ ! -f "$SECRETS_FILE" ]; then
  echo "ERROR: secrets file not found: $SECRETS_FILE"
  exit 1
fi

if ! command -v vercel >/dev/null 2>&1; then
  echo "ERROR: vercel CLI not found. Install: npm i -g vercel"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq not found. Install: brew install jq"
  exit 1
fi

# Verify we're in a Vercel-linked project
if [ ! -f ".vercel/project.json" ]; then
  echo "ERROR: not in a Vercel-linked project (no .vercel/project.json)."
  echo "       cd into sites/stilo-ai/ first, or run: vercel link"
  exit 1
fi

KEYS=$(jq -r 'keys[]' "$SECRETS_FILE")
TOTAL=$(echo "$KEYS" | wc -l | tr -d ' ')
echo "Pushing $TOTAL keys to envs: $ENVS"
echo ""

PUSHED=0
SKIPPED=0
FAILED=0

while IFS= read -r KEY; do
  VALUE=$(jq -r --arg k "$KEY" '.[$k]' "$SECRETS_FILE")

  if [ -z "$VALUE" ] || [ "$VALUE" = "null" ] || [ "$VALUE" = "(not yet set)" ]; then
    echo "  SKIP  $KEY (empty or placeholder)"
    SKIPPED=$((SKIPPED+1))
    continue
  fi

  IFS=',' read -ra ENV_LIST <<< "$ENVS"
  ALL_OK=true
  for ENV in "${ENV_LIST[@]}"; do
    # Remove existing (idempotent re-push)
    vercel env rm "$KEY" "$ENV" --yes >/dev/null 2>&1 || true
    # Add new value
    if printf '%s' "$VALUE" | vercel env add "$KEY" "$ENV" >/dev/null 2>&1; then
      :
    else
      ALL_OK=false
      break
    fi
  done

  if $ALL_OK; then
    MASK="${VALUE:0:8}***"
    echo "  PUSH  $KEY = $MASK   ($ENVS)"
    PUSHED=$((PUSHED+1))
  else
    echo "  FAIL  $KEY"
    FAILED=$((FAILED+1))
  fi
done <<< "$KEYS"

echo ""
echo "Done. Pushed: $PUSHED  Skipped: $SKIPPED  Failed: $FAILED"
echo ""
echo "Trigger a redeploy to pick up the new env vars:"
echo "  vercel --prod"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
