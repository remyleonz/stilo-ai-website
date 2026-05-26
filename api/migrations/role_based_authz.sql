-- =====================================================================
-- Migration A: Role-based authorization (replaces hardcoded ADMIN_EMAILS)
-- =====================================================================
-- Before this migration:
--   Authorization is checked by `auth.jwt()->>'email' in ('remyleon11@...', ...)`
--   in 15+ RLS policies, plus a hardcoded ADMIN_EMAILS array in ~6 code files.
--   Adding/removing an admin = SQL edit + code edit + redeploy.
--
-- After this migration:
--   Authorization is checked by `auth.jwt() #>> '{app_metadata,role}' = 'admin'`.
--   Roles are stamped onto auth.users.raw_app_meta_data by triggers that watch
--   admin_users (and, after Migration B, sdr_users). Adding an admin = one row
--   insert. Role propagates to the JWT on next token refresh.
--
-- Safety:
--   - Belt-and-suspenders during transition: every policy accepts either the
--     role claim OR direct admin_users lookup via SECURITY DEFINER. If a JWT
--     hasn't refreshed yet, the lookup catches them. No one loses access.
--   - Backfill runs before policy rewrites, so every existing admin gets the
--     role stamp before the new policies start enforcing it.
--   - All policy rewrites are drop-then-create; if anything fails mid-way the
--     transaction rolls back and we're back to the original state.
--
-- Migration B will:
--   - Create sdr_users + extend sync_user_role() to handle SDR role
--   - Create client_attribution table
--   - Add attachments to support_messages
--   - Seed Luke / Jack / Alejandro

-- ---------------------------------------------------------------------
-- 1. Helper functions (SECURITY DEFINER so they bypass RLS)
-- ---------------------------------------------------------------------

-- Bypass-RLS lookup: is this email an active admin?
create or replace function public.is_admin_email(p_email text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users
    where lower(email) = lower(coalesce(p_email, ''))
      and active = true
  );
$$;

-- Convenience: is the calling JWT an admin (by role claim OR direct lookup)?
create or replace function public.current_user_is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select (
    (auth.jwt() #>> '{app_metadata,role}') = 'admin'
    or public.is_admin_email(auth.jwt() ->> 'email')
  );
$$;

-- ---------------------------------------------------------------------
-- 2. Role-sync engine
-- ---------------------------------------------------------------------
-- Computes the correct role for an email and writes it to
-- auth.users.raw_app_meta_data. Order of precedence:
--   admin > sdr > client (default)
-- Once Migration B runs, this function picks up sdr_users too — written
-- defensively with to_regclass so it doesn't crash if sdr_users doesn't
-- exist yet.

create or replace function public.sync_user_role(p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := 'client';
  v_is_admin boolean := false;
  v_is_sdr boolean := false;
begin
  if p_email is null or p_email = '' then
    return;
  end if;

  -- Admin check
  select exists (
    select 1 from public.admin_users
    where lower(email) = lower(p_email) and active = true
  ) into v_is_admin;

  -- SDR check (only if sdr_users table exists — created in Migration B)
  if to_regclass('public.sdr_users') is not null then
    execute $sql$
      select exists (
        select 1 from public.sdr_users
        where lower(email) = lower($1) and active = true
      )
    $sql$ into v_is_sdr using p_email;
  end if;

  if v_is_admin then
    v_role := 'admin';
  elsif v_is_sdr then
    v_role := 'sdr';
  end if;

  -- Stamp the role onto auth.users. raw_app_meta_data is the field that
  -- folds into the JWT's app_metadata claim on next sign-in / refresh.
  update auth.users
     set raw_app_meta_data =
       coalesce(raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', v_role)
   where lower(email) = lower(p_email);
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Triggers
-- ---------------------------------------------------------------------

-- 3a. admin_users → sync the affected email's role
create or replace function public.tg_sync_admin_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.sync_user_role(old.email);
    return old;
  end if;
  perform public.sync_user_role(new.email);
  if tg_op = 'UPDATE' and old.email is distinct from new.email then
    perform public.sync_user_role(old.email);
  end if;
  return new;
end;
$$;

drop trigger if exists admin_users_role_sync on public.admin_users;
create trigger admin_users_role_sync
  after insert or update or delete on public.admin_users
  for each row execute function public.tg_sync_admin_role();

-- 3b. auth.users insert → stamp role for brand-new signups
create or replace function public.tg_sync_new_user_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_user_role(new.email);
  return new;
end;
$$;

drop trigger if exists auth_users_role_sync on auth.users;
create trigger auth_users_role_sync
  after insert on auth.users
  for each row execute function public.tg_sync_new_user_role();

-- ---------------------------------------------------------------------
-- 4. Backfill — stamp existing users with their correct role
-- ---------------------------------------------------------------------
-- Every user in auth.users gets re-evaluated. Order matters: admins win.
-- Result for current state: 4 admins (Remy x2 + Stilo + David) → 'admin'.
-- Everyone else → 'client'.

do $$
declare
  r record;
begin
  for r in select email from auth.users where email is not null loop
    perform public.sync_user_role(r.email);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 5. Rewrite RLS policies — replace hardcoded email lists
-- ---------------------------------------------------------------------
-- We use a transitional check: role claim OR is_admin_email() lookup.
-- That way a logged-in admin whose JWT hasn't refreshed yet still has
-- access (the lookup catches them) AND new tokens use the fast role
-- claim path. Once everyone has refreshed (~1hr default JWT lifetime)
-- the lookup is dead weight but it's free (4-row table, cached).

-- ---- public.leads -----------------------------------------------------
drop policy if exists "Admins can view all leads" on public.leads;
create policy "Admins can view all leads" on public.leads
  for select using (public.current_user_is_admin());

-- ---- public.clients ---------------------------------------------------
drop policy if exists "Admins can view all clients" on public.clients;
create policy "Admins can view all clients" on public.clients
  for select using (public.current_user_is_admin() or auth.uid() = id);

-- ---- public.client_agents --------------------------------------------
drop policy if exists "Admins can view all agents" on public.client_agents;
create policy "Admins can view all agents" on public.client_agents
  for select using (public.current_user_is_admin() or client_id = auth.uid());

drop policy if exists "Admins can update all agents" on public.client_agents;
create policy "Admins can update all agents" on public.client_agents
  for update using (public.current_user_is_admin() or client_id = auth.uid());

drop policy if exists "Admins can insert agents" on public.client_agents;
create policy "Admins can insert agents" on public.client_agents
  for insert with check (public.current_user_is_admin());

-- ---- public.onboarding_steps -----------------------------------------
drop policy if exists "Admins can view all onboarding" on public.onboarding_steps;
create policy "Admins can view all onboarding" on public.onboarding_steps
  for select using (
    public.current_user_is_admin()
    or client_agent_id in (select id from public.client_agents where client_id = auth.uid())
  );

-- ---- public.agent_metrics --------------------------------------------
drop policy if exists "Admins can view all metrics" on public.agent_metrics;
create policy "Admins can view all metrics" on public.agent_metrics
  for select using (
    public.current_user_is_admin()
    or client_agent_id in (select id from public.client_agents where client_id = auth.uid())
  );

-- ---- public.contracts -------------------------------------------------
drop policy if exists "Admins can view all contracts" on public.contracts;
create policy "Admins can view all contracts" on public.contracts
  for select using (public.current_user_is_admin() or client_id = auth.uid());

-- ---- public.support_threads ------------------------------------------
drop policy if exists "Admins view all threads" on public.support_threads;
create policy "Admins view all threads" on public.support_threads
  for select using (public.current_user_is_admin());

drop policy if exists "Admins update all threads" on public.support_threads;
create policy "Admins update all threads" on public.support_threads
  for update using (public.current_user_is_admin());

-- ---- public.support_messages -----------------------------------------
drop policy if exists "Admins view all messages" on public.support_messages;
create policy "Admins view all messages" on public.support_messages
  for select using (public.current_user_is_admin());

drop policy if exists "Admins append messages" on public.support_messages;
create policy "Admins append messages" on public.support_messages
  for insert with check (public.current_user_is_admin());

-- ---- public.admin_users ----------------------------------------------
-- Self-referencing admin_users policies need is_admin_email() directly
-- (avoids recursion through the policy on the table being read).
drop policy if exists "Admins view admin users" on public.admin_users;
create policy "Admins view admin users" on public.admin_users
  for select using (public.current_user_is_admin());

drop policy if exists "Admins insert admin users" on public.admin_users;
create policy "Admins insert admin users" on public.admin_users
  for insert with check (public.current_user_is_admin());

drop policy if exists "Admins update admin users" on public.admin_users;
create policy "Admins update admin users" on public.admin_users
  for update using (public.current_user_is_admin());

-- ---------------------------------------------------------------------
-- 6. Verification queries (read-only, return result sets)
-- ---------------------------------------------------------------------
-- Run these manually after migration to verify role stamps landed.
--   select email, raw_app_meta_data->'role' as role from auth.users order by email;
--   select email, public.is_admin_email(email) from auth.users where email is not null;
