-- 2026-05-27: Quiz V3 — capture quiz_complete leads and store fit-scores
--
-- Adds:
--   * 'quiz_complete' as a permitted cta_type so we capture finishers even
--     before they click any CTA button.
--   * website column (optional URL the prospect typed during step 1).
--   * agent_scores jsonb column: the per-agent fit score the recommender
--     computed (e.g. { receptionist: 14, "lead-response": 9, ... }). Lets us
--     audit which scoring signals drove which recommendation later.
--
-- Idempotent: safe to run multiple times.

CREATE TABLE IF NOT EXISTS public.quiz_submissions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  cta_type        text NOT NULL,
  contact_name    text,
  email           text,
  phone           text,
  business_name   text,
  website         text,
  quiz_answers    jsonb,
  tier            text,
  selected_agents jsonb,
  agent_scores    jsonb,
  estimated_price text,
  referrer        text,
  page_url        text,
  ip              text,
  user_agent      text
);

-- Add columns if the table predates this migration
ALTER TABLE public.quiz_submissions ADD COLUMN IF NOT EXISTS website      text;
ALTER TABLE public.quiz_submissions ADD COLUMN IF NOT EXISTS agent_scores jsonb;

-- Loosen any existing cta_type CHECK so 'quiz_complete' is valid.
-- (If the table was created without a CHECK, this is a no-op.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'quiz_submissions'
      AND constraint_type = 'CHECK'
      AND constraint_name LIKE 'quiz_submissions_cta_type%'
  ) THEN
    EXECUTE 'ALTER TABLE public.quiz_submissions DROP CONSTRAINT IF EXISTS quiz_submissions_cta_type_check';
  END IF;
END $$;

ALTER TABLE public.quiz_submissions
  ADD CONSTRAINT quiz_submissions_cta_type_check
  CHECK (cta_type IN ('purchase','audit','quiz_complete'));

-- Index for the Outbound Lead Reply Agent's "fresh quiz_complete leads" query
CREATE INDEX IF NOT EXISTS quiz_submissions_quiz_complete_idx
  ON public.quiz_submissions (cta_type, created_at DESC)
  WHERE cta_type = 'quiz_complete';

-- Index for email lookups (dedupe + cross-event linking)
CREATE INDEX IF NOT EXISTS quiz_submissions_email_idx
  ON public.quiz_submissions (lower(email))
  WHERE email IS NOT NULL;
