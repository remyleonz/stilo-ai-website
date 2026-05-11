-- ============================================================================
-- Backfill: ensure every existing client has a business_profile row.
-- ============================================================================
--
-- Run this ONCE in Supabase SQL Editor (not idempotent-blocking, but the
-- WHERE NOT EXISTS clause makes re-runs safe — it's a no-op after first pass).
--
-- What this does:
--   1. Inserts a `business_profile` client_agents row for every client who
--      doesn't have one yet, with status='onboarding' and empty config.
--   2. Inserts the 8 onboarding_steps rows for each newly-created profile,
--      with step 1 as 'in_progress' and the rest as 'pending'.
--
-- Safe to run on production. Wraps in a transaction so it's all-or-nothing.
--
-- After running, every client login will see the Business Profile tile first,
-- and existing paid agents will show the locked-overlay state until the
-- profile is completed (≥80% with TCPA + owner consent).
--
-- Verify after running:
--   SELECT count(*) FROM public.client_agents WHERE agent_type='business_profile';
--   -- should equal: SELECT count(*) FROM public.clients;
-- ============================================================================

BEGIN;

-- 1) Insert business_profile rows for any client that doesn't have one.
WITH inserted AS (
  INSERT INTO public.client_agents (client_id, agent_type, status, stripe_subscription_id, config, onboarding_progress)
  SELECT c.id, 'business_profile', 'onboarding', NULL, '{}'::jsonb, '{}'::jsonb
  FROM public.clients c
  WHERE NOT EXISTS (
    SELECT 1 FROM public.client_agents ca
    WHERE ca.client_id = c.id AND ca.agent_type = 'business_profile'
  )
  RETURNING id
)
SELECT count(*) AS profiles_created FROM inserted;

-- 2) Seed the 8 onboarding_steps for any business_profile row that doesn't have steps yet.
-- (Some legacy rows may have been created without steps; this safely backfills them too.)
WITH step_template(step_number, step_name) AS (
  VALUES
    (1, 'Identity & contact'),
    (2, 'Niche & services'),
    (3, 'Hours & availability'),
    (4, 'Brand voice'),
    (5, 'Knowledge base'),
    (6, 'Logo & assets'),
    (7, 'Compliance & legal'),
    (8, 'Systems already in place')
),
profiles_missing_steps AS (
  SELECT ca.id AS client_agent_id
  FROM public.client_agents ca
  WHERE ca.agent_type = 'business_profile'
    AND NOT EXISTS (
      SELECT 1 FROM public.onboarding_steps os WHERE os.client_agent_id = ca.id
    )
),
inserted_steps AS (
  INSERT INTO public.onboarding_steps (client_agent_id, step_number, step_name, status, data)
  SELECT
    p.client_agent_id,
    s.step_number,
    s.step_name,
    CASE WHEN s.step_number = 1 THEN 'in_progress' ELSE 'pending' END,
    '{"response_data": {}}'::jsonb
  FROM profiles_missing_steps p
  CROSS JOIN step_template s
  RETURNING client_agent_id
)
SELECT count(*) AS step_rows_created FROM inserted_steps;

COMMIT;

-- ============================================================================
-- Verification queries (run separately to spot-check)
-- ============================================================================

-- Total clients vs. total business_profile rows (should be equal):
-- SELECT
--   (SELECT count(*) FROM public.clients) AS total_clients,
--   (SELECT count(*) FROM public.client_agents WHERE agent_type='business_profile') AS total_profiles;

-- Profiles missing onboarding_steps (should be zero after running this):
-- SELECT ca.id, ca.client_id
-- FROM public.client_agents ca
-- WHERE ca.agent_type = 'business_profile'
--   AND NOT EXISTS (SELECT 1 FROM public.onboarding_steps os WHERE os.client_agent_id = ca.id);

-- Profile completion distribution (informational):
-- SELECT
--   status,
--   count(*) AS n
-- FROM public.client_agents
-- WHERE agent_type='business_profile'
-- GROUP BY status;
