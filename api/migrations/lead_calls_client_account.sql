-- Stamp the account a call was made ON BEHALF OF, at call time.
--
-- Until now the only account marker was sdr_users.sdr_type, a property of the
-- PERSON. That misreports history the moment anyone changes accounts: when Remy
-- moved onto Blason on 2026-08-27, all 617 of his dials and all 8 of his booked
-- meetings — every one of them STILO new business from June through August —
-- jumped into the Blason group. Alejandro has the same problem in reverse.
--
-- An account belongs to the CALL, not the caller. NULL means STILO's own new
-- business, which is the overwhelming majority and the right default.
--
-- Backfill rule (applied in scripts/backfill_call_accounts.js, not here,
-- because it needs the clients table from the public schema):
--     a call is client work IFF
--        the lead carries that client_id
--     AND the call happened at or after that client's created_at
--
-- The date half is load-bearing. Blason's 1,001-lead list overlaps STILO's own
-- prospecting ICP, so 4 calls from June and July sit on leads that only became
-- Blason's on 2026-08-25. Matching on client_id alone would backdate them into
-- an engagement that did not exist yet. Note also that lead 19613 — Blason the
-- prospect Remy sold TO — correctly carries client_id NULL, so the calls that
-- won the account stay STILO new business.
alter table prospecting.lead_calls
    add column if not exists client_account text;

comment on column prospecting.lead_calls.client_account is
    'Business name of the client this call was made on behalf of, as of call time. NULL = STILO new business. Set at write time by the OpenPhone webhook and the manual log-call route; see scripts/backfill_call_accounts.js for history.';

create index if not exists lead_calls_client_account_idx
    on prospecting.lead_calls (client_account)
    where client_account is not null;

-- Same column on messages, same rule. An SMS or email sent on a client's
-- behalf is that client's work, and the Team tab counts emails alongside dials.
alter table prospecting.lead_messages
    add column if not exists client_account text;

comment on column prospecting.lead_messages.client_account is
    'Business name of the client this message was sent on behalf of, as of send time. NULL = STILO new business.';

create index if not exists lead_messages_client_account_idx
    on prospecting.lead_messages (client_account)
    where client_account is not null;
