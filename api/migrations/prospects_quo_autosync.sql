-- ============================================
-- Auto-sync HOT prospects to Quo as contacts
-- ============================================
-- Whenever a prospect lands as HOT (or gets promoted to HOT) and has a
-- phone, fire an HTTP POST from Postgres to the Vercel sync endpoint via
-- the pg_net extension. The endpoint creates/updates the Quo contact and
-- writes the resulting Quo contact id back to prospects.quo_contact_id.
--
-- Auth: shared bearer secret stored in private.app_secrets (not exposed via
-- PostgREST since it lives in the `private` schema). The Vercel endpoint
-- compares incoming Authorization header against the SUPABASE_TRIGGER_SECRET
-- env var which holds the same value.
--
-- Run in Supabase SQL Editor (or applied via the migration runner).

create extension if not exists pg_net with schema extensions;

alter table public.prospects
    add column if not exists quo_contact_id text;

-- Private schema for secrets the API layer reads via service role only.
create schema if not exists private;
create table if not exists private.app_secrets (
    key text primary key,
    value text not null,
    updated_at timestamptz not null default now()
);
revoke all on private.app_secrets from anon, authenticated;

create or replace function public.sync_prospect_to_quo()
returns trigger
language plpgsql
security definer
as $$
declare
    payload jsonb;
    secret  text;
    is_hot_now boolean;
    became_hot boolean;
    phone_changed boolean;
    script_changed boolean;
begin
    is_hot_now := NEW.tier = 'HOT';
    became_hot := TG_OP = 'UPDATE' AND (OLD.tier IS DISTINCT FROM NEW.tier) AND NEW.tier = 'HOT';
    phone_changed := TG_OP = 'UPDATE' AND OLD.owner_phone IS DISTINCT FROM NEW.owner_phone;
    script_changed := TG_OP = 'UPDATE' AND OLD.talk_track IS DISTINCT FROM NEW.talk_track;

    -- Fire on: any HOT insert; any update where tier flipped to HOT; any
    -- update of an already-HOT row where phone or script changed (so the
    -- contact in Quo stays current).
    if NEW.owner_phone IS NULL then return NEW; end if;
    if NOT (
        (TG_OP = 'INSERT' AND is_hot_now)
        OR became_hot
        OR (is_hot_now AND TG_OP = 'UPDATE' AND (phone_changed OR script_changed))
    ) then
        return NEW;
    end if;

    select value into secret from private.app_secrets where key = 'quo_sync_trigger';
    if secret IS NULL OR secret = '' then
        raise warning 'private.app_secrets[quo_sync_trigger] not set; skipping Quo sync for prospect %', NEW.id;
        return NEW;
    end if;

    payload := jsonb_build_object(
        'type', TG_OP,
        'table', TG_TABLE_NAME,
        'record', to_jsonb(NEW)
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

drop trigger if exists trg_prospects_quo_sync on public.prospects;
create trigger trg_prospects_quo_sync
    after insert or update on public.prospects
    for each row execute function public.sync_prospect_to_quo();
