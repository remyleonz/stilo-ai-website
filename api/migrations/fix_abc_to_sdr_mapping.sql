-- =====================================================================
-- Correct A/B/C → SDR mapping: A=jack, B=luke, C=alejandro
-- =====================================================================
-- Original migration accidentally mapped A→luke, B→jack, C→alejandro.
-- Remy's roster order is A=jack, B=luke, C=alejandro. Applied via the
-- Supabase MCP on 2026-05-26.

create or replace function prospecting.set_default_assigned_to()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_rep_key text;
begin
  if new.assigned_to is not null then
    return new;
  end if;

  -- Sage routing precedence (set at scrape-time): A→jack, B→luke, C→alejandro.
  v_rep_key := case lower(coalesce(new.tentative_rep_assignment, ''))
                 when 'a' then 'jack'
                 when 'b' then 'luke'
                 when 'c' then 'alejandro'
                 else null
               end;

  if v_rep_key is not null then
    select s.email into v_email
      from public.sdr_users s
     where s.sdr_key = v_rep_key and s.active = true
     limit 1;
    if v_email is not null then
      new.assigned_to := v_email;
      return new;
    end if;
  end if;

  -- Round-robin fallback: SDR with the fewest existing leads.
  select s.email into v_email
    from public.sdr_users s
    left join prospecting.leads l on l.assigned_to = s.email
   where s.active = true
   group by s.email
   order by count(l.id) asc, s.email asc
   limit 1;

  if v_email is null then
    v_email := 'remyleon@stiloaipartners.com';
  end if;

  new.assigned_to := v_email;
  return new;
end;
$$;

-- Matching storage RLS so rep-a/ reads are jack-only, rep-b/ luke-only, etc.
drop policy if exists "SDRs read own rep cold-call-briefs" on storage.objects;
create policy "SDRs read own rep cold-call-briefs" on storage.objects
  for select using (
    bucket_id = 'cold-call-briefs'
    and (auth.jwt() #>> '{app_metadata,role}') = 'sdr'
    and (
      (name like 'rep-a/%' and exists (select 1 from public.sdr_users s where s.auth_user_id = auth.uid() and s.sdr_key = 'jack'))
      or (name like 'rep-b/%' and exists (select 1 from public.sdr_users s where s.auth_user_id = auth.uid() and s.sdr_key = 'luke'))
      or (name like 'rep-c/%' and exists (select 1 from public.sdr_users s where s.auth_user_id = auth.uid() and s.sdr_key = 'alejandro'))
    )
  );
