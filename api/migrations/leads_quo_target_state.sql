-- ============================================
-- Quo target-state sync trigger
-- ============================================
-- Per David's recommendation: instead of separate create/update/delete
-- paths, the trigger fires whenever lifecycle-relevant fields change and
-- the receiver decides the right action based on whether the lead's
-- current state matches "should be in Quo Contacts."
--
-- A lead SHOULD be in Quo when ALL of:
--   - prospect_tier = 'hot' (case-insensitive)
--   - do_not_call IS NOT TRUE
--   - last_called_outcome != 'booked_meeting'  (already won, no need to dial)
--   - owner_phone or phone IS NOT NULL
--
-- Trigger fires on INSERT/UPDATE when the lead was eligible OR is now
-- eligible OR the lifecycle fields changed (so demotion/DNC/booked
-- transitions all reach the receiver). The receiver then PATCH/POST/DELETE
-- as appropriate against Quo and writes back quo_contact_id.

create or replace function prospecting.sync_lead_to_quo()
returns trigger
language plpgsql
security definer
as $$
declare
    payload jsonb;
    secret  text;
    is_hot_now boolean;
    was_hot boolean;
    eligible_now boolean;
    was_eligible boolean;
    lifecycle_changed boolean;
    has_quo_record boolean;
begin
    is_hot_now := lower(coalesce(NEW.prospect_tier, NEW.tier, '')) = 'hot';
    was_hot := TG_OP = 'UPDATE'
               AND lower(coalesce(OLD.prospect_tier, OLD.tier, '')) = 'hot';

    eligible_now := is_hot_now
                    AND COALESCE(NEW.do_not_call, false) = false
                    AND COALESCE(NEW.last_called_outcome, '') != 'booked_meeting'
                    AND COALESCE(NEW.owner_phone, NEW.phone) IS NOT NULL;

    was_eligible := TG_OP = 'UPDATE'
                    AND was_hot
                    AND COALESCE(OLD.do_not_call, false) = false
                    AND COALESCE(OLD.last_called_outcome, '') != 'booked_meeting'
                    AND COALESCE(OLD.owner_phone, OLD.phone) IS NOT NULL;

    -- Did any lifecycle-relevant field change while the row remained in scope?
    lifecycle_changed := TG_OP = 'UPDATE' AND (
        OLD.prospect_tier IS DISTINCT FROM NEW.prospect_tier
        OR OLD.tier IS DISTINCT FROM NEW.tier
        OR COALESCE(OLD.do_not_call, false) IS DISTINCT FROM COALESCE(NEW.do_not_call, false)
        OR COALESCE(OLD.last_called_outcome, '') IS DISTINCT FROM COALESCE(NEW.last_called_outcome, '')
        OR COALESCE(OLD.owner_phone, OLD.phone) IS DISTINCT FROM COALESCE(NEW.owner_phone, NEW.phone)
        OR OLD.business_profile IS DISTINCT FROM NEW.business_profile
        OR OLD.outreach_angle IS DISTINCT FROM NEW.outreach_angle
        OR OLD.matched_product_name IS DISTINCT FROM NEW.matched_product_name
    );

    has_quo_record := COALESCE(NEW.quo_contact_id, '') != '';

    -- Skip the trigger entirely when nothing relevant could have changed.
    -- Insert: only fire if eligible NOW (otherwise nothing to do).
    -- Update: fire if was eligible (delete-or-update path) OR is eligible now
    --        (create-or-update path) OR has a Quo record we need to keep in sync.
    if TG_OP = 'INSERT' AND NOT eligible_now then return NEW; end if;
    if TG_OP = 'UPDATE' AND NOT (was_eligible OR eligible_now OR (has_quo_record AND lifecycle_changed)) then
        return NEW;
    end if;

    select value into secret from private.app_secrets where key = 'quo_sync_trigger';
    if secret IS NULL OR secret = '' then
        raise warning 'private.app_secrets[quo_sync_trigger] not set; skipping Quo sync for lead %', NEW.id;
        return NEW;
    end if;

    payload := jsonb_build_object(
        'type', TG_OP,
        'table', TG_TABLE_NAME,
        'record', to_jsonb(NEW),
        'old_record', case when TG_OP = 'UPDATE' then to_jsonb(OLD) else null end,
        'eligible_now', eligible_now,
        'was_eligible', was_eligible
    );

    perform net.http_post(
        url := 'https://stiloaipartners.com/api/openphone/sync-from-supabase',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || secret
        ),
        body := payload,
        timeout_milliseconds := 5000
    );

    return NEW;
end;
$$;

-- Trigger definition unchanged; the function body absorbed the logic.
drop trigger if exists trg_leads_quo_sync on prospecting.leads;
create trigger trg_leads_quo_sync
    after insert or update on prospecting.leads
    for each row execute function prospecting.sync_lead_to_quo();
