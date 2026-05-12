-- ============================================
-- prospecting.leads.assigned_to + parity backfill
-- ============================================
-- The Leads tab (admin/index.html) scopes its workflow cards (All Leads,
-- Called Today, Callbacks Due, Dead Pool) and tables to an SDR via this
-- column. Until it exists, every per-SDR query falls back to global counts
-- (173 callable_ready for All Leads, 4,767 tier-dead archive for Dead Pool).
--
-- Backfill uses the same parity rule the frontend already applies as a
-- fallback (`fallbackSdrFor` in admin/index.html): even id → Remy, odd → David.
-- That keeps the All Leads count consistent with what the table renders.
--
-- Run in Supabase SQL Editor against project zsrskphpvgautfgklgxf
-- (stilo-ai-partners).

set search_path = prospecting, public;

alter table prospecting.leads
  add column if not exists assigned_to text;

create index if not exists leads_assigned_to_idx
  on prospecting.leads (assigned_to);

-- Backfill only nulls — never overwrite an explicit assignment.
update prospecting.leads
   set assigned_to = case
     when (id::bigint) % 2 = 0 then 'remyleon@stiloaipartners.com'
     else 'davidcoira@stiloaipartners.com'
   end
 where assigned_to is null;

-- Default-on-insert so new leads from David's pipeline pick an owner.
-- Same parity, computed in a tiny trigger so the rule lives in one place.
create or replace function prospecting.set_default_assigned_to()
returns trigger
language plpgsql
as $$
begin
  if new.assigned_to is null then
    new.assigned_to := case
      when (new.id::bigint) % 2 = 0 then 'remyleon@stiloaipartners.com'
      else 'davidcoira@stiloaipartners.com'
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists leads_assigned_to_default on prospecting.leads;
create trigger leads_assigned_to_default
  before insert on prospecting.leads
  for each row execute function prospecting.set_default_assigned_to();

-- Sanity: counts per SDR after backfill.
select assigned_to, count(*) as leads
  from prospecting.leads
 group by assigned_to
 order by leads desc;
