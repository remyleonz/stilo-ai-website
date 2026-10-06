#!/bin/zsh
# Blason daily autopilot. Runs from launchd (com.stilo.blason-sms-daily / -email-daily).
# SMS leg: enqueue yesterday's connected dials into campaign 4, fill copy from the
# Claude-authored template bank (scripts/blason_copy_templates.js — no Gemini), then
# STRIP any body that fails the banned-pattern check so bad copy can never send.
# Email leg: run the client sequence with --send, cap 50.
# Logs: ~/Library/Logs/blason-autopilot.log
set -u
ENVF="/Users/remyleon/Desktop/AI Agency/sites/stilo-ai/.env.local"
export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
export ENVF
CRON=$(grep '^CRON_SECRET=' "$ENVF" | cut -d= -f2- | tr -d '"')
LOG="$HOME/Library/Logs/blason-autopilot.log"
STAMP=$(date '+%Y-%m-%d %H:%M')
LEG="${1:-sms}"
# Wait for the network. launchd runs a missed 9:30 job the moment the Mac wakes,
# before Wi-Fi is back, and every fetch then fails (ERR fetch failed, 9/30 and 10/1).
for i in $(seq 1 36); do curl -s -o /dev/null --max-time 5 https://stiloaipartners.com && break; sleep 5; done
{
echo "[$STAMP] === autopilot leg: $LEG ==="
if [ "$LEG" = "sms" ]; then
  # 2026-10-05 (Remy): the VIDEO campaign (outbound campaign 5) is the SMS arm.
  # Campaign 4 is paused. Bodies are prefilled by the script (David's angle +
  # the signed link), so no generate step and no validation gate are needed;
  # outbound-tick sends 100/day inside the 9am to 7pm ET window.
  node "/Users/remyleon/Desktop/AI Agency/sites/stilo-ai/scripts/enqueue_blason_vsl_sms.js" --limit 100 --write 2>&1 | tail -4
else
  # Daily email program, 50 total: step-2 follow-ups first, then lane 1
  # (medium+deliverable), then lane 2 (MX-confirmed role inboxes) fills the
  # remainder. Every run passes the 8% trailing-bounce breaker and the
  # bounce-domain blacklist + shared-inbox dedupe inside the script.
  SEQ="/Users/remyleon/Desktop/AI Agency/sites/stilo-ai/scripts/send_client_sequence.js"
  # 2026-09-29: lane 2 (role inboxes) OFF. It bounced 19 of 60 in 14 days
  # (~30%) and kept tripping the 8% breaker, which also froze lane 1. Its
  # slots go to follow-ups (steps 2 to 5), which bounce 3 to 7%.
  # 2026-10-05 (Remy): the VIDEO is the email program. 100/day:
  #   70 re-engage = already emailed and delivered by the old sequence, no
  #      reply, never got the video (email_N stamps untouched)
  #   30 new = never emailed, lane auto (rep-typed first, then verified
  #      personal, then at most 10 finder role inboxes)
  # plus the video follow-ups (ten touches over nine weeks, confirmed addresses,
  # main domain; new addresses go out from the test domain). The old
  # sequence's followup/value legs are OFF while the video runs.
  VSL="/Users/remyleon/Desktop/AI Agency/sites/stilo-ai/scripts/send_blason_vsl_email.js"
  # Top up to TARGET a day (Remy, 2026-10-06: "ideally 100 emails a day for
  # Blason"). Follow-ups first (they are due, confirmed addresses, main domain),
  # then re-engage, then new addresses from the test domain fill the rest.
  # Never fewer than MIN_COLD new addresses, so the test lane keeps proving
  # supply even on a heavy follow-up day.
  TARGET=100; MIN_COLD=30
  sent_of() { grep -o '"sent":[0-9]*' | tail -1 | cut -d: -f2; }
  OUT=$(node "$VSL" --mode followup --limit $TARGET --send 2>&1); echo "$OUT" | tail -2
  F=$(echo "$OUT" | sent_of); F=${F:-0}
  REM=$((TARGET - F)); [ "$REM" -lt "$MIN_COLD" ] && REM=$MIN_COLD
  OUT=$(node "$VSL" --mode re --limit $REM --send 2>&1); echo "$OUT" | tail -2
  R=$(echo "$OUT" | sent_of); R=${R:-0}
  REM=$((REM - R)); [ "$REM" -lt "$MIN_COLD" ] && REM=$MIN_COLD
  node "$VSL" --mode cold --lane auto --limit $REM --send 2>&1 | tail -2
  echo "email leg: followup $F, re $R, cold up to $REM (target $TARGET)"
fi
echo "[$STAMP] === leg $LEG done ==="
} >> "$LOG" 2>&1
