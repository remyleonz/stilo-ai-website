-- 2026-05-20: language flag + owner-name freshness columns
--
-- Why:
--   - primary_language: surface bilingual / Spanish-first leads on the brief
--     so non-bilingual SDRs know to skip or hand off. Auto-set by the Quo
--     webhook when a transcript arrives; manually overridable from the
--     dashboard.
--   - owner_name_last_verified / owner_name_previous: catch stale owner
--     names before the SDR opens with the wrong person (Frank Gonzales
--     at WynWellness incident, 2026-05-06). The phone-finder batch job
--     bumps owner_name_last_verified when it re-runs; if the lookup returns
--     a different name, the old name lands in owner_name_previous so we
--     can detect departures and rebrief.

ALTER TABLE prospecting.leads
    ADD COLUMN IF NOT EXISTS primary_language text;            -- 'en' / 'es' / 'pt' / NULL when unknown

ALTER TABLE prospecting.leads
    ADD COLUMN IF NOT EXISTS owner_name_last_verified timestamptz;

ALTER TABLE prospecting.leads
    ADD COLUMN IF NOT EXISTS owner_name_previous text;

-- Backfill owner_name_last_verified from the best timestamp we already have
-- per row. Conservative: only stamps rows that actually have an owner_name.
UPDATE prospecting.leads
   SET owner_name_last_verified = COALESCE(owner_phone_searched_at, email_searched_at, created_at)
 WHERE owner_name IS NOT NULL
   AND owner_name_last_verified IS NULL;

-- Useful indexes for the agent's queries.
CREATE INDEX IF NOT EXISTS leads_primary_language_idx
    ON prospecting.leads (primary_language);

CREATE INDEX IF NOT EXISTS leads_owner_name_last_verified_idx
    ON prospecting.leads (owner_name_last_verified)
    WHERE owner_name_last_verified IS NOT NULL;
