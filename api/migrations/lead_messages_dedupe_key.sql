-- Make a manual email send idempotent.
--
-- api/prospects/send-email.js had NO duplicate guard of any kind — only a
-- bounce guard — and it sends first, logs second. So any second request for
-- the same email sends a second email: a double-click, a client retry, a proxy
-- replaying a slow POST, or two operators on the same lead.
--
-- Measured 2026-08-28: 5 pairs since Aug 1 landed 1 to 3 seconds apart with
-- consecutive lead_messages ids, three of them that day. Prospects received
-- the same email twice.
--
-- A read-then-write check cannot fix this. Two requests two seconds apart both
-- read an empty history before either writes, pass, and both send. The guard
-- has to be a constraint the database enforces, so the loser fails instead of
-- racing.
--
-- dedupe_key is set by the sender BEFORE calling Resend and carries a 5-minute
-- time bucket, so a genuine follow-up with the same subject days later is
-- unaffected — only a near-simultaneous repeat collides. NULL is allowed and
-- not deduplicated, so every existing row and every other writer is untouched.
alter table prospecting.lead_messages
    add column if not exists dedupe_key text;

comment on column prospecting.lead_messages.dedupe_key is
    'Idempotency key claimed before send: sha1(lead|channel|to|subject|5-min bucket). Unique when present. NULL means the writer opted out of dedupe.';

create unique index if not exists lead_messages_dedupe_key_uidx
    on prospecting.lead_messages (dedupe_key)
    where dedupe_key is not null;
