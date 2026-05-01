-- ============================================
-- Agent events: per-deployment raw event log
-- ============================================
-- Companion to the existing agent_metrics table. Where agent_metrics stores
-- one daily aggregate per (client_agent_id, metric_date), agent_events stores
-- the raw stream: every call_received, call_completed, email_sent, kpi_update,
-- error, config_updated, etc.
--
-- Source: tail of Clients/{slug}/agents/{type}/logs/events.jsonl, synced by
-- CEO Agent/scripts/metrics_sync.py on each cron tick.
--
-- Read by:
--   sites/stilo-ai/admin/index.html        (client drawer "last 10 events")
--   sites/stilo-ai/app/agents/index.html   (per-agent activity feed)
--
-- Run in Supabase SQL Editor against the stilo-ai-partners project.

create table if not exists public.agent_events (
  id uuid primary key default gen_random_uuid(),
  client_agent_id uuid not null references public.client_agents(id) on delete cascade,
  event_type text not null,
  occurred_at timestamptz not null,
  run_id text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists agent_events_agent_time_idx
  on public.agent_events(client_agent_id, occurred_at desc);

create index if not exists agent_events_type_idx
  on public.agent_events(event_type, occurred_at desc);

-- Dedupe key: same (client_agent_id, run_id, event_type) shouldn't appear
-- twice. The metrics_sync writer uses on conflict do nothing.
create unique index if not exists agent_events_dedupe_idx
  on public.agent_events(client_agent_id, event_type, run_id)
  where run_id is not null;

alter table public.agent_events enable row level security;

create policy "Clients view own events" on public.agent_events
  for select using (
    client_agent_id in (
      select id from public.client_agents where client_id = auth.uid()
    )
  );

create policy "Admins view all events" on public.agent_events
  for select using (
    auth.jwt()->>'email' in ('remyleon11@gmail.com', 'stiloaiconsulting@gmail.com')
  );

-- Inserts only via service role (the Python metrics_sync writer). No
-- client-facing insert policy.
