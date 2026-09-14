# Send-path environment flags (production source of truth: Vercel dashboard)

Every flag below is default-CLOSED in code: a preview deploy, a local run, or a
missing var means the path is inert. Set to 'true' (exact string) to open.

| Flag | Path it arms | Prod value | Notes |
|------|--------------|-----------|-------|
| OUTBOUND_SEND_ENABLED | outbound-tick SMS sender | true | campaigns also need status='running' |
| EMAIL_SEQUENCE_ENABLED | /api/prospects/email-sequence cron | true | 40/day cap in vercel.json |
| VSL_FLOW_ENABLED / VSL_NURTURE_ENABLED | VSL blast + vsl-nurture | true | |
| NURTURE_SEND_ENABLED | schedule-nurture + send-nurture-value | true (set 2026-09-14) | booked-client value touches |
| BOOKING_TOKEN_SECRET | signing secret for public booking/attribution links | set 2026-09-14 | Pinned to the value that was in use (the then-current service key), so rotating SUPABASE_SERVICE_KEY no longer invalidates live links. Never rotate this one casually: every outstanding link dies. |

Removed for good (do not reintroduce):
- ALLOW_LEGACY_GENERATED_SCRIPTS (2026-09-14): re-armed 609 pre-pivot AI-receptionist
  cold-call scripts. The branches are deleted from sync-scripts.js and cold-call-script.js.
- GEMINI_API_KEY is no longer read by any COPY path (_outbound, _nurture_value,
  draft-email). Copy is curated in-repo and personalized deterministically.
  sync-meet-transcripts still uses Gemini for internal transcript analysis only.
