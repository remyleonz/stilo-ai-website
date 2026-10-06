-- 2026-10-06 "Call now" queue (applied via Supabase MCP the same day)
alter table prospecting.leads
  add column if not exists hot_at timestamptz,
  add column if not exists hot_reason text,
  add column if not exists hot_cleared_at timestamptz;
create index if not exists leads_hot_at_idx on prospecting.leads (hot_at desc) where hot_at is not null;
