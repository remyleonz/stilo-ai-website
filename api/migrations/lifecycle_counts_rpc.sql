-- Collapse the Leads-tab counters into ONE query.
--
-- api/prospects/lifecycle-stats.js fired TEN PostgREST requests per call, each
-- a `count=exact, head=true` over prospecting.leads. Every one of them is a
-- full sequential scan (no index covers the OR-chains), so a single page load
-- asked for ten whole-table scans. The admin Leads tab then called the endpoint
-- SIX times on mount, which is sixty concurrent scans from one browser.
--
-- Measured 2026-08-29: each count runs in 86 ms inside Postgres, but ten in
-- parallel stalled in the PostgREST layer roughly every other attempt, hanging
-- past 30 s with the DATABASE COMPLETELY IDLE (pg_stat_activity showed no
-- active query and no lock waits). The endpoint never returned, so the four
-- workflow cards sat on their em-dash placeholders forever and the lead list
-- sat on "Loading prospects...". Nothing rendered an error, because nothing
-- ever failed — it simply never came back. The only reason the tab worked at
-- all some of the time was the 15-second edge cache masking the origin hang.
--
-- One pass, ten FILTER aggregates. Same scan, same numbers, one round trip.
-- The predicates below are a literal transcription of the PostgREST chains in
-- localStats(); note that repeated .or() calls are ANDed together, which is why
-- each OR group is its own parenthesised term.
create or replace function prospecting.lead_lifecycle_counts(
    p_sdr_email  text,
    p_client_id  uuid,
    p_start_day  timestamp,
    p_start_week timestamp,
    p_end_day    timestamp
)
returns json
language sql
stable
security definer
set search_path = prospecting, public
as $$
with base as (
    select *
      from prospecting.leads
     where (p_sdr_email is null or assigned_to = p_sdr_email)
       and (p_client_id is null or client_id = p_client_id)
),
-- "Callable" = a dialable phone, not DNC, still in the cold-call lifecycle.
-- The per-lead script gate applies to STILO leads only; a client campaign runs
-- one shared script, so client mode drops it (mirrors callable.js).
flagged as (
    select
        prospect_tier,
        last_called_outcome,
        last_called_at,
        next_action_type,
        next_action_due_at,
        (
            (owner_phone is not null or phone is not null)
            and (do_not_call is null or do_not_call = false)
            and (last_called_outcome is null or last_called_outcome not in
                 ('booked_meeting','dnc_request','wrong_number','disconnected','do_not_call'))
            and (p_client_id is not null or has_cold_call_script = true)
        ) as is_callable,
        (
            last_called_outcome in
                ('booked_meeting','dnc_request','wrong_number','disconnected','do_not_call')
            or (call_attempts >= 3 and last_called_outcome is null)
        ) as is_dead,
        (
            (
                last_called_outcome in ('callback_requested','interested_followup')
                or (next_action_type = 'callback'
                    and (last_called_outcome is null or last_called_outcome not in
                         ('voicemail','no_answer','missed_inbound')))
            )
            and (do_not_call is null or do_not_call = false)
        ) as is_callback
      from base
)
select json_build_object(
    'hot',        count(*) filter (where is_callable and prospect_tier = 'hot'),
    'warm',       count(*) filter (where is_callable and prospect_tier = 'warm'),
    'cool',       count(*) filter (where is_callable and prospect_tier = 'cool'),
    'dead_pool',  count(*) filter (where is_dead),
    'callbacks',  count(*) filter (where is_callback),
    'booked',     count(*) filter (where last_called_outcome = 'booked_meeting'),
    'called_today', count(*) filter (where last_called_at >= p_start_day),
    'booked_week',  count(*) filter (where last_called_outcome = 'booked_meeting'
                                       and last_called_at >= p_start_week),
    'callbacks_due', count(*) filter (
        where next_action_type = 'callback'
          and next_action_due_at <= p_end_day
          and (last_called_outcome is null or last_called_outcome not in
               ('voicemail','no_answer','missed_inbound'))),
    'all_callable', count(*) filter (where is_callable)
) from flagged;
$$;

comment on function prospecting.lead_lifecycle_counts is
    'All ten Leads-tab counters in a single table scan. Replaces ten parallel PostgREST count=exact requests that stalled the REST layer (see lifecycle_counts_rpc.sql, 2026-08-29).';

grant execute on function prospecting.lead_lifecycle_counts(text, uuid, timestamp, timestamp, timestamp) to service_role;
