-- ============================================
-- LCR Suppressions table
-- ============================================
-- Backs the suppression checks in:
--   LCR Agent/python/suppressions.py        (read before every email + SMS send)
--   sites/stilo-ai/api/unsubscribe.js       (write on email unsubscribe click)
--   sites/stilo-ai/api/sms_optout.js        (write on Twilio STOP webhook)
--
-- Per-client scope: a customer who unsubscribes from Client A is NOT auto-
-- unsubscribed from Client B. Each (client_slug, email) and (client_slug, phone)
-- pair is unique.
--
-- Run in Supabase SQL Editor against the stilo-ai-partners project.

create table if not exists public.lcr_suppressions (
  id uuid primary key default gen_random_uuid(),
  client_slug text not null,
  email text,
  phone text,
  source text not null,        -- email_unsubscribe, sms_stop, hard_bounce, manual, complaint
  opted_out_at timestamptz not null default now(),
  notes text,
  -- At least one of email or phone must be present.
  constraint lcr_suppressions_contact_check check (email is not null or phone is not null)
);

-- Per-client uniqueness on each contact channel. Partial unique indexes
-- because either email or phone may be null.
create unique index if not exists lcr_suppressions_client_email_uniq
  on public.lcr_suppressions(client_slug, email)
  where email is not null;

create unique index if not exists lcr_suppressions_client_phone_uniq
  on public.lcr_suppressions(client_slug, phone)
  where phone is not null;

create index if not exists lcr_suppressions_client_idx
  on public.lcr_suppressions(client_slug);

create index if not exists lcr_suppressions_opted_out_idx
  on public.lcr_suppressions(opted_out_at desc);

-- RLS: only the service role (used by /api handlers and by the Python
-- suppressions module via SUPABASE_SERVICE_KEY) and admin emails can read
-- or write. No public access.
alter table public.lcr_suppressions enable row level security;

create policy "Admins can read suppressions" on public.lcr_suppressions
  for select using (
    auth.jwt()->>'email' in ('remyleon11@gmail.com', 'stiloaiconsulting@gmail.com')
  );

create policy "Admins can write suppressions" on public.lcr_suppressions
  for insert with check (
    auth.jwt()->>'email' in ('remyleon11@gmail.com', 'stiloaiconsulting@gmail.com')
  );

create policy "Admins can update suppressions" on public.lcr_suppressions
  for update using (
    auth.jwt()->>'email' in ('remyleon11@gmail.com', 'stiloaiconsulting@gmail.com')
  );

-- ============================================
-- Clients table additions
-- ============================================
-- The unsubscribe + sms_optout endpoints look up the client by slug and by
-- twilio_account_sid. Add those columns if they don't already exist.

alter table public.clients add column if not exists slug text;
alter table public.clients add column if not exists twilio_account_sid text;

create unique index if not exists clients_slug_uniq
  on public.clients(slug)
  where slug is not null;

create unique index if not exists clients_twilio_sid_uniq
  on public.clients(twilio_account_sid)
  where twilio_account_sid is not null;
