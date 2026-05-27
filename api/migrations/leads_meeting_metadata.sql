-- leads_meeting_metadata.sql
-- 2026-05-27
--
-- Persist Google Calendar / Meet metadata on the lead row when an SDR books
-- a meeting through /api/prospects/book-meeting. Today the event is created
-- on the shared primary calendar but the link is returned and forgotten —
-- so the admin Booked Meeting tab can't surface "Open in Calendar" or
-- "Join Meet" buttons after the fact.
--
-- Columns added:
--   meeting_event_id        Google Calendar event ID (used for cancel/reschedule)
--   meeting_event_link      htmlLink to open in Google Calendar
--   meeting_meet_link       Google Meet join URL
--   meeting_scheduled_at    Start time of the booked meeting (TIMESTAMPTZ)
--   meeting_duration_min    Duration in minutes (default 15)
--   meeting_booked_by_sdr   Email of the SDR who booked it (separate from
--                           assigned_to since an admin can book on behalf
--                           of any rep)
--
-- All columns are nullable + additive. Safe to re-run.

ALTER TABLE prospecting.leads
    ADD COLUMN IF NOT EXISTS meeting_event_id       TEXT,
    ADD COLUMN IF NOT EXISTS meeting_event_link     TEXT,
    ADD COLUMN IF NOT EXISTS meeting_meet_link      TEXT,
    ADD COLUMN IF NOT EXISTS meeting_scheduled_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS meeting_duration_min   INTEGER,
    ADD COLUMN IF NOT EXISTS meeting_booked_by_sdr  TEXT;

-- Speeds up the Booked Meeting tab's "show me upcoming meetings first" sort.
CREATE INDEX IF NOT EXISTS idx_leads_meeting_scheduled_at
    ON prospecting.leads (meeting_scheduled_at DESC NULLS LAST)
    WHERE meeting_scheduled_at IS NOT NULL;
