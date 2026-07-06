-- nurture_stage.sql
-- 2026-07-06
--
-- Track where a booked lead sits in the pre-meeting NURTURE sequence.
-- The nurture email automation is NOT built yet, so today the admin dashboard
-- DERIVES the stage from existing signals (meeting_scheduled_at, an outbound
-- value email in prospecting.lead_messages, a prospecting.lead_meetings row
-- with an outcome). This column lets an operator OVERRIDE that derivation, and
-- gives the future automation a place to write the authoritative stage.
--
-- Stages, in order:
--   booked      meeting is on the calendar, sequence has started
--   vsl_sent    the VSL / intro video has been sent
--   value       the daily value email is going out
--   triaged     pre-meeting triage / qualification done
--   confirmed   prospect confirmed they'll attend
--   showed      prospect showed up (meeting happened)
--
-- Column added:
--   nurture_stage TEXT (nullable) — one of the stage keys above, or NULL to
--                 fall back to the dashboard's derivation. A CHECK constraint
--                 keeps the value in the known set (NULL always allowed).
--
-- Nullable + additive. Safe to re-run.

ALTER TABLE prospecting.leads
    ADD COLUMN IF NOT EXISTS nurture_stage TEXT;

-- Constrain to the known stage keys (NULL stays allowed = "derive it").
-- Wrapped so re-running the migration doesn't error on an existing constraint.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'leads_nurture_stage_check'
    ) THEN
        ALTER TABLE prospecting.leads
            ADD CONSTRAINT leads_nurture_stage_check
            CHECK (nurture_stage IN ('booked','vsl_sent','value','triaged','confirmed','showed'));
    END IF;
END$$;

-- Only booked leads are ever mid-sequence, so a partial index on the non-null
-- rows keeps the "how many leads are mid-sequence" count cheap.
CREATE INDEX IF NOT EXISTS idx_leads_nurture_stage
    ON prospecting.leads (nurture_stage)
    WHERE nurture_stage IS NOT NULL;
