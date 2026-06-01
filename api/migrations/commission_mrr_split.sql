-- Commission split: setup fee vs monthly retainer.
--
-- Before: a single commission_pct was applied to BOTH the one-time setup fee
-- and the recurring monthly retainer (effectively 25% on everything).
--
-- After (per Remy, 2026-05-31): SDR commission is
--   - commission_pct      = 25% of the one-time setup/upfront fee
--   - commission_mrr_pct  = 10% of the recurring monthly retainer, paid for as
--                           long as the client is retained.
--
-- commission_pct keeps its meaning as the SETUP rate so the existing column +
-- all its references stay valid; we only add the new MRR rate.

alter table public.sdr_users
  add column if not exists commission_mrr_pct numeric not null default 0.10;

comment on column public.sdr_users.commission_pct is
  'SDR commission rate on the one-time setup/upfront fee (e.g. 0.25 = 25%).';
comment on column public.sdr_users.commission_mrr_pct is
  'SDR commission rate on the recurring monthly retainer (e.g. 0.10 = 10%), paid while the client is active.';

alter table public.client_attribution
  add column if not exists commission_mrr_pct numeric;

comment on column public.client_attribution.commission_pct is
  'Snapshot of the SDR setup-fee commission rate, locked in at close.';
comment on column public.client_attribution.commission_mrr_pct is
  'Snapshot of the SDR monthly-retainer commission rate, locked in at close.';
