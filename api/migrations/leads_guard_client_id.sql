-- 2026-09-01: APPLIED to prod (migration guard_lead_client_id_unassign).
--
-- Why: a full-row PATCH sync that walks prospecting.leads with stale row
-- snapshots nulled client_id on ~325 Blason leads mid-pass. While a row was
-- null, draft-email's client_campaign branch could not fire and the composer
-- served STILO "interested lead" copy for a client lead (content firewall
-- breach, seen live on lead 31579 / Vellu Laser). The pass restored every row
-- but 31579 as it caught up, which is what made it look intermittent.
--
-- client_id assignment is deliberate and rare. Losing it is never a legitimate
-- side effect of an enrichment write, so the trigger keeps the OLD value when
-- an UPDATE tries to null an existing one. Intentional unassignment goes
-- through prospecting.unassign_lead_client(lead_id).
create or replace function prospecting.keep_lead_client_id()
returns trigger
language plpgsql
as $$
begin
  if old.client_id is not null and new.client_id is null
     and coalesce(current_setting('stilo.allow_client_unassign', true), '') <> 'on' then
    new.client_id := old.client_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_keep_lead_client_id on prospecting.leads;
create trigger trg_keep_lead_client_id
  before update of client_id on prospecting.leads
  for each row
  execute function prospecting.keep_lead_client_id();

create or replace function prospecting.unassign_lead_client(p_lead_id bigint)
returns void
language plpgsql
security definer
as $$
begin
  perform set_config('stilo.allow_client_unassign', 'on', true);
  update prospecting.leads set client_id = null where id = p_lead_id;
end;
$$;
