-- Stamp client_account automatically, in the database.
--
-- Calls and messages are written from at least six places: the OpenPhone
-- webhook, openphone/dial, prospects/log-call, book-meeting, mark-booked, the
-- SMS senders. Patching each one to set client_account would work today and
-- rot the first time somebody adds a seventh, and the failure mode is silent —
-- a client's work quietly counted as STILO's.
--
-- So the rule lives next to the data. Same rule as the backfill:
--     client work IFF the lead carries a client_id
--                 AND the row's timestamp is at or after that client's created_at
--
-- An explicitly supplied client_account always wins, so a caller that knows
-- better (a client-account campaign, say) is never overridden.

create or replace function prospecting.stamp_client_account()
returns trigger
language plpgsql
security definer
set search_path = prospecting, public
as $$
declare
    v_name text;
    v_since timestamptz;
    v_when timestamptz;
begin
    -- Explicit value wins.
    if new.client_account is not null then
        return new;
    end if;
    if new.lead_id is null then
        return new;
    end if;

    select c.business_name, c.created_at
      into v_name, v_since
      from prospecting.leads l
      join public.clients c on c.id = l.client_id
     where l.id = new.lead_id;

    if v_name is null then
        return new;
    end if;

    -- Read the timestamp through jsonb rather than naming both columns. A
    -- CASE over tg_table_name still has to RESOLVE new.sent_at when the
    -- trigger fires on lead_calls, and PL/pgSQL raises
    -- 'record "new" has no field "sent_at"' before the CASE ever picks a
    -- branch. jsonb access is late-bound, so one function serves both tables.
    v_when := coalesce(
        (to_jsonb(new) ->> 'called_at')::timestamptz,
        (to_jsonb(new) ->> 'sent_at')::timestamptz
    );

    -- No timestamp means we cannot prove the row falls inside the engagement,
    -- so it stays STILO work rather than being guessed into a client's numbers.
    if v_when is not null and v_when >= v_since then
        new.client_account := v_name;
    end if;

    return new;
end;
$$;

drop trigger if exists stamp_client_account on prospecting.lead_calls;
create trigger stamp_client_account
    before insert or update of lead_id, called_at on prospecting.lead_calls
    for each row execute function prospecting.stamp_client_account();

drop trigger if exists stamp_client_account on prospecting.lead_messages;
create trigger stamp_client_account
    before insert or update of lead_id, sent_at on prospecting.lead_messages
    for each row execute function prospecting.stamp_client_account();
