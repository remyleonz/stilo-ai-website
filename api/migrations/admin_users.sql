-- ============================================
-- Admin users: replaces the hardcoded ADMIN_EMAILS array
-- ============================================
-- Today the admin allowlist is hardcoded in three places:
--   sites/stilo-ai/admin/index.html  (client-side gate)
--   sites/stilo-ai/app/index.html    (redirect-to-admin gate)
--   sites/stilo-ai/api/*.js          (server-side admin checks)
-- Plus every RLS policy in schema.sql.
--
-- The admin Settings tab needs to add/remove team members at runtime, so
-- the source of truth moves into a Supabase table. Code paths read from
-- this table at startup (with a small in-memory cache).
--
-- The RLS policies on the existing tables stay JWT-email-based for
-- performance (avoids a per-query lookup), but the email list they check
-- is generated from this table by the /api/admin/admin-users endpoint when
-- the team is changed. For the initial migration we seed the two known
-- admins so policies don't break.
--
-- Run in Supabase SQL Editor against the stilo-ai-partners project.

create table if not exists public.admin_users (
  email text primary key,
  display_name text,
  added_by text,
  added_at timestamptz not null default now(),
  active boolean not null default true
);

-- Seed the two existing admins so nothing breaks at cutover.
insert into public.admin_users (email, display_name, added_by)
values
  ('remyleon11@gmail.com', 'Remy Leon', 'system'),
  ('stiloaiconsulting@gmail.com', 'Stilo AI Consulting', 'system'),
  ('remyleon@stiloaipartners.com', 'Remy Leon', 'system'),
  ('davidcoira@stiloaipartners.com', 'David Coira', 'system')
on conflict (email) do nothing;

alter table public.admin_users enable row level security;

create policy "Admins view admin users" on public.admin_users
  for select using (
    auth.jwt()->>'email' in (
      select email from public.admin_users where active = true
    )
  );

create policy "Admins insert admin users" on public.admin_users
  for insert with check (
    auth.jwt()->>'email' in (
      select email from public.admin_users where active = true
    )
  );

create policy "Admins update admin users" on public.admin_users
  for update using (
    auth.jwt()->>'email' in (
      select email from public.admin_users where active = true
    )
  );

-- Helper: returns true if the calling user's email is an active admin.
-- Existing policies still use the hardcoded email-list pattern for speed;
-- the admin-users endpoint regenerates those policies whenever the team
-- changes (TODO: implement that regen step in the endpoint).
create or replace function public.is_admin()
returns boolean as $$
  select exists (
    select 1 from public.admin_users
    where email = auth.jwt()->>'email' and active = true
  );
$$ language sql stable security definer;
