-- ============================================
-- Impersonation audit: every action an admin takes while signed in as a
-- client lands here. Append-only.
-- ============================================
-- Backs the "Open as client (full access)" flow:
--   1. Admin clicks the button in admin/index.html client drawer
--   2. POST /api/admin/impersonate returns a 15-minute Supabase JWT scoped
--      to the target client_id
--   3. The impersonated session calls /app or /admin endpoints normally;
--      every mutation routes through audit-logging proxies that insert one
--      row here per action.
--
-- The table is admin-read-only. No update or delete policies.
--
-- Run in Supabase SQL Editor against the stilo-ai-partners project.

create table if not exists public.impersonation_audit (
  id uuid primary key default gen_random_uuid(),
  admin_email text not null,
  client_id uuid not null references public.clients(id) on delete cascade,
  action text not null,         -- e.g. update_agent_config, save_onboarding_step
  target_table text,            -- e.g. client_agents, onboarding_steps
  target_id uuid,
  payload jsonb default '{}',
  created_at timestamptz not null default now()
);

create index if not exists impersonation_audit_client_idx
  on public.impersonation_audit(client_id, created_at desc);

create index if not exists impersonation_audit_admin_idx
  on public.impersonation_audit(admin_email, created_at desc);

alter table public.impersonation_audit enable row level security;

create policy "Admins view audit" on public.impersonation_audit
  for select using (
    auth.jwt()->>'email' in ('remyleon11@gmail.com', 'stiloaiconsulting@gmail.com')
  );

-- Inserts only via service role. The /api/admin/impersonate endpoint and
-- impersonated mutation proxies write here using SUPABASE_SERVICE_KEY.
