-- Free email verification, DNS only. See scripts/verify_lead_emails.js.
--
-- Context: the sending domain was at 14.9% bounce (75 of 505 sends). A sweep of
-- all 3,190 distinct addresses found 485 (14.6%) on domains with NO MX record.
-- That near-match is the whole explanation, and it was detectable for free.
--
-- email_verify_address exists so a verdict can be invalidated by an edit. If
-- owner_email changes after verification, the stored status no longer describes
-- the address on the record, and a stale "deliverable" is exactly how a bad
-- address slips back into a bulk send. Senders compare the two and treat a
-- mismatch as unverified.

alter table prospecting.leads
  add column if not exists email_verify_status     text,
  add column if not exists email_verify_reason     text,
  add column if not exists email_verify_checked_at timestamptz,
  add column if not exists email_verify_address    text;

comment on column prospecting.leads.email_verify_status is
  'deliverable | dead_domain | role_inbox | malformed | unchecked. Only ''deliverable'' should be bulk-mailed.';
comment on column prospecting.leads.email_verify_address is
  'The exact address that was checked, so a later edit to owner_email invalidates the verdict.';

create index if not exists leads_email_verify_idx on prospecting.leads (email_verify_status);
create index if not exists leads_email_unchecked_idx on prospecting.leads (id)
  where email_verify_status is null;

-- Cached per DOMAIN, not per address: 3,190 addresses share only 2,980 domains
-- and MX records rarely change, which makes re-verification nearly free.
create table if not exists prospecting.email_domain_cache (
  domain      text primary key,
  has_mx      boolean not null,
  mx_host     text,
  checked_at  timestamptz not null default now()
);
