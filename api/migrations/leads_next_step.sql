-- CRM next step on booked-meeting leads (applied 2026-08-09).
--
-- The Sales tab booked panel shows an editable "next step" per meeting lead so
-- the owner can see where every meeting stands without opening leads one by one.
-- Separate columns on purpose:
--   - rep_notes          = the rep's sticky call note (never touched here)
--   - next_action_due_at = the callback scheduler's field
--   - next_step / next_step_due = the CRM follow-through, written only by
--     /api/prospects/set-next-step
alter table prospecting.leads
    add column if not exists next_step text,
    add column if not exists next_step_due date;
