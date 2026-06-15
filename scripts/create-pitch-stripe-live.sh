#!/usr/bin/env bash
# Create the Sales Agent (AI Sales Agent: coaching + outbound automation)
# product + prices in Stripe LIVE mode, then push the resulting price IDs to
# Vercel for the stilo-ai project.
#
# Repositioned 2026-05-26: was "AI Sales Coach" at $2,500 + $1,500/mo
# (coaching only). Now bundles email automation on top of coaching —
# same agent code 'pitch', expanded scope, $2,500 + $2,000/mo.
#
# Use --refresh-existing to create new LIVE prices and overwrite the Vercel
# envs (typical case when the pricing changes). Without it the script will
# fail if the env vars already exist.
#
# Prereq: export STRIPE_LIVE_KEY=sk_live_... (the live secret key for the
# Stilo AI Partners Stripe account).
#
# Usage:
#   STRIPE_LIVE_KEY=sk_live_xxx bash sites/stilo-ai/scripts/create-pitch-stripe-live.sh

set -euo pipefail

if [ -z "${STRIPE_LIVE_KEY:-}" ]; then
  echo "ERROR: STRIPE_LIVE_KEY env var is required (sk_live_...)"
  exit 1
fi

if [[ "$STRIPE_LIVE_KEY" != sk_live_* ]] && [[ "$STRIPE_LIVE_KEY" != rk_live_* ]]; then
  echo "ERROR: STRIPE_LIVE_KEY must start with sk_live_ or rk_live_. Got: ${STRIPE_LIVE_KEY:0:10}..."
  exit 1
fi

echo "Creating Sales Agent product in LIVE mode (AI Sales Agent)..."
PRODUCT=$(curl -s "https://api.stripe.com/v1/products" \
  -u "${STRIPE_LIVE_KEY}:" \
  -d "name=PITCH - AI Sales Agent" \
  -d "description=Listens to every cold call, closing call, meeting, and email thread. Rewrites your scripts and sequences against what actually closes. Sends the outbound follow-ups for you on a cadence you control. Per-rep scorecards + weekly playbook." \
  --data-urlencode "metadata[agent_code]=pitch" \
  --data-urlencode "metadata[stilo_agent]=true")

PRODUCT_ID=$(echo "$PRODUCT" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "PRODUCT_ID=$PRODUCT_ID"

echo "Creating Sales Agent setup (\$2,500) price..."
SETUP=$(curl -s "https://api.stripe.com/v1/prices" \
  -u "${STRIPE_LIVE_KEY}:" \
  -d "product=$PRODUCT_ID" \
  -d "currency=usd" \
  -d "unit_amount=250000" \
  --data-urlencode "nickname=PITCH Setup (one-time)")
SETUP_ID=$(echo "$SETUP" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SETUP_ID=$SETUP_ID"

echo "Creating Sales Agent monthly (\$2,000/mo, coaching + automation) price..."
MONTHLY=$(curl -s "https://api.stripe.com/v1/prices" \
  -u "${STRIPE_LIVE_KEY}:" \
  -d "product=$PRODUCT_ID" \
  -d "currency=usd" \
  -d "unit_amount=200000" \
  -d "recurring[interval]=month" \
  --data-urlencode "nickname=PITCH Monthly Retainer (coaching + automation)")
MONTHLY_ID=$(echo "$MONTHLY" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "MONTHLY_ID=$MONTHLY_ID"

echo ""
echo "==> Pushing LIVE price IDs to Vercel Production (overwriting any existing test-mode values)..."
cd "$(dirname "$0")/.."
vercel env rm STRIPE_PRICE_PITCH_SETUP production --yes 2>/dev/null || true
vercel env rm STRIPE_PRICE_PITCH_MONTHLY production --yes 2>/dev/null || true
vercel env add STRIPE_PRICE_PITCH_SETUP production --value "$SETUP_ID" --yes
vercel env add STRIPE_PRICE_PITCH_MONTHLY production --value "$MONTHLY_ID" --yes

echo ""
echo "Done. LIVE Sales Agent price IDs are now in Vercel Production."
echo "  STRIPE_PRICE_PITCH_SETUP = $SETUP_ID"
echo "  STRIPE_PRICE_PITCH_MONTHLY = $MONTHLY_ID"
echo ""
echo "Remember to update secrets-registry.md with the masked LIVE IDs and"
echo "redeploy the site so the new env vars are picked up:"
echo "  vercel --prod"
