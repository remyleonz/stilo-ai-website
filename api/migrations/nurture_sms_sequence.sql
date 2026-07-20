-- Nurture SMS sequence (2026-07-19)
--
-- The post-booking flow is now three texts, all from the booking rep's own Quo
-- line, plus the existing confirmation email that carries the VSL link:
--
--   1. ~5 min after the meeting is booked  -> send-confirmations.js
--      (already stamped by meeting_confirmation_sent_at)
--   2. ~5 min after the prospect opens the confirm VSL page -> send-vsl-followup.js
--   3. ~1 day before the meeting -> send-day-before.js
--
-- Each needs its own idempotency stamp. Without these, a cron that ticks every
-- 5 minutes would re-text the prospect on every single run.

ALTER TABLE prospecting.leads
    ADD COLUMN IF NOT EXISTS vsl_followup_sms_sent_at timestamptz,
    ADD COLUMN IF NOT EXISTS day_before_sms_sent_at   timestamptz;

COMMENT ON COLUMN prospecting.leads.vsl_followup_sms_sent_at IS
    'Step 2 of the nurture SMS sequence: sent ~5 min after the prospect opened the confirm VSL page. Idempotency stamp for send-vsl-followup.js.';
COMMENT ON COLUMN prospecting.leads.day_before_sms_sent_at IS
    'Step 3 of the nurture SMS sequence: sent ~1 day before the booked meeting. Idempotency stamp for send-day-before.js.';

-- send-vsl-followup.js scans for leads whose confirm-flow VSL event is old
-- enough and that have not been followed up yet. Both crons also filter on
-- meeting_scheduled_at being in the future.
CREATE INDEX IF NOT EXISTS leads_vsl_followup_pending_idx
    ON prospecting.leads (meeting_scheduled_at)
    WHERE vsl_followup_sms_sent_at IS NULL AND meeting_scheduled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS leads_day_before_pending_idx
    ON prospecting.leads (meeting_scheduled_at)
    WHERE day_before_sms_sent_at IS NULL AND meeting_scheduled_at IS NOT NULL;

-- The VSL follow-up joins from public.vsl_events back to the lead, filtered to
-- the confirm flow. Without this the lookup is a seq scan on a table that grows
-- with every page view and every mail-scanner pixel hit.
CREATE INDEX IF NOT EXISTS vsl_events_confirm_lead_idx
    ON public.vsl_events (lead_id, created_at)
    WHERE flow = 'confirm' AND lead_id IS NOT NULL;
