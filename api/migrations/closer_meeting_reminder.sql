-- Closer T-15 reminder stamp (2026-07-25)
--
-- On 2026-07-24 lead 22413 (Maxwell Bossis) joined his booked Meet and no STILO
-- closer showed up. The T-15 cron (send-meeting-reminders.js) reminded the
-- prospect but nothing reminded the internal team. The cron now also emails the
-- closers (Remy + David) at T-15.
--
-- That send needs its own idempotency stamp. It must NOT reuse
-- meeting_reminder_sent_at: the prospect send and the closer send can succeed
-- or fail independently, and one shared stamp would let a prospect-side success
-- silently swallow a closer-side failure (or the reverse).
--
-- book-meeting.js nulls this alongside the other per-meeting stamps when a
-- meeting is rebooked, so a moved meeting gets a fresh closer reminder too.

ALTER TABLE prospecting.leads
    ADD COLUMN IF NOT EXISTS closer_reminder_sent_at timestamptz;

COMMENT ON COLUMN prospecting.leads.closer_reminder_sent_at IS
    'T-15 internal reminder emailed to the STILO closers (Remy + David) before a booked meeting. Idempotency stamp for the closer half of send-meeting-reminders.js. Cleared on rebooking by book-meeting.js.';
