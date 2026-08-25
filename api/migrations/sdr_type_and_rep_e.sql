-- SDR categories + Melanye Altuve's brief folder.
--
-- Until now every rep on public.sdr_users did the same job: cold call to win
-- STILO new clients. From 2026-08-24 there are two jobs, and mixing them
-- corrupts every company number we look at. A rep dialling for Blason Spa
-- books meetings onto BLASON's calendar against BLASON's ICP. Counting those
-- in "meetings booked this week" would tell us our own pipeline is healthy
-- when nobody dialled a single STILO prospect.
--
--   new_client     - dials our prospect list to win STILO new clients.
--                    The role everyone has had until now. Stays the default so
--                    every existing row keeps its current meaning.
--   client_account - dials a paying client's list on that client's behalf.
--                    client_account names which one.
--
-- This is a different axis from is_closer in team-analytics.js, which is
-- derived from commission_pct = 0 and means "runs the closing call". A rep can
-- be a client-account SDR and never close, which is the normal case.
alter table public.sdr_users
    add column if not exists sdr_type text not null default 'new_client',
    add column if not exists client_account text;

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'sdr_users_sdr_type_check'
    ) then
        alter table public.sdr_users
            add constraint sdr_users_sdr_type_check
            check (sdr_type in ('new_client', 'client_account'));
    end if;
end $$;

-- A client-account rep must say whose account, and a new-client rep must not
-- carry one. Without this the column drifts into a free-text note nobody trusts.
do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'sdr_users_client_account_check'
    ) then
        alter table public.sdr_users
            add constraint sdr_users_client_account_check
            check (
                (sdr_type = 'client_account' and client_account is not null
                 and length(btrim(client_account)) > 0)
                or
                (sdr_type = 'new_client' and client_account is null)
            );
    end if;
end $$;

comment on column public.sdr_users.sdr_type is
    'new_client = dials for STILO''s own pipeline. client_account = dials a paying client''s list on their behalf; see client_account.';
comment on column public.sdr_users.client_account is
    'Business name of the client this rep dials for. Non-null only when sdr_type = client_account.';
