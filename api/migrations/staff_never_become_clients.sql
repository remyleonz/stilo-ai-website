-- Stop new SDR hires from landing in the Clients list, and add rep-e.
--
-- THE BUG (recurring; hit again on 2026-08-24 with Melanye Altuve).
-- public.handle_new_user already guarded on the role:
--     if coalesce(new.raw_app_meta_data->>'role','') in ('sdr','admin')
--         then return new; end if;
-- and it still let her through. The guard is correct and fires too early.
-- GoTrue's admin create API INSERTs the auth.users row first and applies the
-- caller's app_metadata in a FOLLOW-UP UPDATE, so at INSERT time
-- raw_app_meta_data has only {provider, providers} and 'role' is null. Every
-- SDR provisioned through POST /auth/v1/admin/users therefore gets a
-- public.clients row whose id IS their auth user id. Melanye's clients row was
-- stamped 01:27:01 and her sdr_users row 01:27:09, eight seconds apart.
--
-- Two defences, because a rep can legitimately be created in either order:
--   (a) INSERT time: also skip anyone already on a staff roster, which covers
--       "sdr_users row created first, then the auth user".
--   (b) UPDATE time: drop the shell row the moment the role actually lands,
--       which covers the admin-API order above. Only a SHELL row is removed:
--       blank business_name, no deals, no client_agents. A real client who
--       later joins staff keeps their account.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  -- Role claim, when it is already present.
  if coalesce(new.raw_app_meta_data->>'role', '') in ('sdr', 'admin') then
    return new;
  end if;

  -- Roster lookup, for when the role has not been applied yet. The admin API
  -- sets app_metadata in a second statement, so the claim above is null on the
  -- insert that fires this trigger.
  if exists (select 1 from public.sdr_users   where lower(email) = lower(new.email))
  or exists (select 1 from public.admin_users where lower(email) = lower(new.email)) then
    return new;
  end if;

  insert into public.clients (id, business_name, contact_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'business_name', ''),
    coalesce(new.raw_user_meta_data->>'contact_name', ''),
    new.email
  );
  return new;
end;
$function$;

-- (b) The role arrives late. Remove the shell client row it raced past.
create or replace function public.tg_drop_shell_client_for_staff()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if coalesce(new.raw_app_meta_data->>'role', '') not in ('sdr', 'admin') then
    return new;
  end if;
  if coalesce(old.raw_app_meta_data->>'role', '') = coalesce(new.raw_app_meta_data->>'role', '') then
    return new;
  end if;

  delete from public.clients c
   where c.id = new.id
     and coalesce(btrim(c.business_name), '') = ''
     and not exists (select 1 from public.deals d         where d.client_id = c.id)
     and not exists (select 1 from public.client_agents a where a.client_id = c.id);

  return new;
end;
$function$;

drop trigger if exists auth_users_staff_client_cleanup on auth.users;
create trigger auth_users_staff_client_cleanup
    after update of raw_app_meta_data on auth.users
    for each row execute function public.tg_drop_shell_client_for_staff();

-- Clean up the two rows already on the list. Melanye is the bug above. The
-- STILO AI PARTNERS row is the agency's own account from 2026-04-14; admin
-- access reads public.admin_users via is_admin_email(), never clients.is_admin,
-- and Remy is on that roster, so removing it does not affect his access.
delete from public.clients
 where id = 'ac3cca89-6fb5-4204-a8f6-aa3438962082'   -- Melanye Altuve, shell row
    or id = '67155ce7-faeb-432b-8f42-13599583660c';  -- STILO AI PARTNERS, own account
