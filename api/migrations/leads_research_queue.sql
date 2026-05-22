-- 2026-05-20: research queue columns
--
-- Why: the "Find Leads" action on the admin dashboard pulls 200 candidates
-- from the 16k pool and stamps them as research-queued. Sage's
-- deep_research_callable Cloud Run Job picks them up by querying for
-- research_status='queued' AND deep_research_done_at IS NULL.
--
-- Lifecycle:
--   NULL                     -- not in queue
--   'queued'                 -- find-more-callable stamped it; waiting for Sage
--   'in_progress'            -- Sage picked it up and is mid-research
--   NULL + deep_research_done_at IS NOT NULL  -- Sage finished, row is normal

ALTER TABLE prospecting.leads
    ADD COLUMN IF NOT EXISTS research_status text,
    ADD COLUMN IF NOT EXISTS research_queued_at timestamptz,
    ADD COLUMN IF NOT EXISTS research_queued_by text;

CREATE INDEX IF NOT EXISTS leads_research_status_idx
    ON prospecting.leads (research_status)
    WHERE research_status IS NOT NULL;
