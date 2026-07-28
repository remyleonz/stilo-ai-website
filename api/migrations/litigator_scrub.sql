-- Litigator / DNC scrub gate for prospecting.leads
--
-- Why this exists: serial TCPA plaintiffs are a real population. They keep
-- numbers specifically to be called and texted, and they fund themselves on
-- $500-per-violation statutory damages. One of them sitting in David's brief
-- folder costs more than the entire month of dialing that found them. Every
-- lead that becomes dial-ready now passes a scrub first.
--
-- Design notes that matter:
--
--   * scrub_status is deliberately NOT boolean. 'clear' and 'blocked' are
--     answers; 'pending' and 'error' are the absence of an answer. A lead that
--     was never successfully scrubbed must never be mistaken for a clean one,
--     so the SMS sender requires status = 'clear' explicitly rather than
--     "not blocked".
--
--   * scrub_phone records WHICH number was checked. leads carries up to three
--     (owner_phone_e164, owner_phone, phone) and they do not always agree. A
--     scrub of the main business line tells you nothing about the owner's cell.
--     The sender compares the number it is about to text against scrub_phone
--     and refuses on a mismatch, which turns a silent hole into a loud skip.
--
--   * A block sets leads.do_not_call = true. That column is already honored by
--     callable.js, the SDR queues, and the owner queues, so a blocked lead
--     disappears from dialing without any new filter having to be added.
--
--   * scrub_blocks is an append-only audit trail. If a lead row is later edited,
--     re-ingested, or un-DNC'd by hand, the record of why we blocked it survives.
--     That record is the evidence if anyone ever asks.

alter table prospecting.leads
  add column if not exists scrub_status     text,
  add column if not exists scrub_checked_at timestamptz,
  add column if not exists scrub_provider   text,
  add column if not exists scrub_reason     text,
  add column if not exists scrub_phone      text,
  add column if not exists scrub_flags      jsonb;

comment on column prospecting.leads.scrub_status is
  'clear | blocked | pending | error. Only ''clear'' authorizes an SMS send.';
comment on column prospecting.leads.scrub_phone is
  'The exact E.164 number that was scrubbed. Senders must match against this.';

-- Partial index: the hot query is "what still needs scrubbing", not "show me
-- everything". Keeps the backfill's resume scan cheap on 21k rows.
create index if not exists leads_scrub_pending_idx
  on prospecting.leads (id)
  where scrub_status is null or scrub_status in ('pending', 'error');

create index if not exists leads_scrub_status_idx
  on prospecting.leads (scrub_status);

create table if not exists prospecting.scrub_blocks (
  id         bigserial primary key,
  lead_id    integer not null,
  phone      text,
  provider   text,
  reason     text,
  flags      jsonb,
  source     text,                    -- 'sync-scripts' | 'backfill' | 'manual'
  blocked_at timestamptz not null default now()
);

create index if not exists scrub_blocks_lead_idx on prospecting.scrub_blocks (lead_id);
create index if not exists scrub_blocks_at_idx   on prospecting.scrub_blocks (blocked_at desc);

-- Service role only. Nothing here is client-readable; the dashboards reach it
-- through the API handlers, which already gate on admin/SDR JWTs.
alter table prospecting.scrub_blocks enable row level security;
