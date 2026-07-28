-- Two features, one migration.
--
-- 1. OUTBOUND: an SMS campaign engine with a kanban state machine, drip pacing,
--    reply capture, and a 4-minute callback clock.
-- 2. NURTURE VALUE TOUCHES: scheduled per-lead value emails/SMS between the
--    booking and the meeting, on top of the existing confirmation sequence.
--
-- ============================================================================
-- OUTBOUND
-- ============================================================================
--
-- SAFETY, read before enabling: a campaign sends only when BOTH
--   (a) outbound_campaigns.status = 'running', and
--   (b) env OUTBOUND_SEND_ENABLED = 'true'
-- Two independent locks, both defaulting to off, because the failure mode here
-- is texting several hundred real business owners by accident. Creating a
-- campaign, enqueueing it, and previewing every generated message are all safe
-- with the locks closed.

create table if not exists prospecting.outbound_campaigns (
    id                    bigserial primary key,
    name                  text not null,
    -- draft -> running -> paused -> done. Never defaults to running.
    status                text not null default 'draft',
    created_by            text,
    created_at            timestamptz not null default now(),
    started_at            timestamptz,

    -- Pacing. per_line_daily_cap is the one that actually protects you: carriers
    -- score per sending number, so 500/day across 6 lines is survivable while
    -- 500/day down one line is not.
    daily_cap             int  not null default 500,
    per_line_daily_cap    int  not null default 75,
    drip_interval_seconds int  not null default 600,
    send_window_start     time not null default '09:00',
    send_window_end       time not null default '19:00',
    timezone              text not null default 'America/New_York',

    -- Callback SLA in minutes. Cameron's rule is speed-to-lead; this is the
    -- clock the board counts down.
    callback_sla_minutes  int  not null default 4,

    -- Per-step authoring guidance fed to the generator alongside each lead's
    -- own record. NOT a raw template: the generator personalizes per lead.
    step1_guidance        text,
    step2_guidance        text,
    step3_guidance        text,
    notes                 text
);

create table if not exists prospecting.outbound_targets (
    id                  bigserial primary key,
    campaign_id         bigint not null references prospecting.outbound_campaigns(id) on delete cascade,
    lead_id             integer not null,

    assigned_to         text,   -- rep email, drives which Quo line sends
    from_line           text,   -- resolved E.164 at enqueue time
    to_phone            text,   -- E.164, must equal leads.scrub_phone

    -- queued -> sent -> replied -> booked | dead. blocked/opted_out/failed are
    -- terminal side states.
    stage               text not null default 'queued',
    step                int  not null default 0,  -- highest step delivered

    step1_body          text, step1_sent_at timestamptz,
    step2_body          text, step2_sent_at timestamptz,
    step3_body          text, step3_sent_at timestamptz,

    first_reply_at      timestamptz,
    first_reply_body    text,
    reply_alert_sent_at timestamptz,

    -- Set when the first reply lands. The board counts down to this.
    callback_due_at     timestamptz,
    called_back_at      timestamptz,
    called_back_by      text,

    last_error          text,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),

    -- One row per lead per campaign. This is the idempotency backbone: the send
    -- worker advances a row it has already claimed, so a double-tick cannot
    -- produce a double-send.
    unique (campaign_id, lead_id)
);

create index if not exists outbound_targets_stage_idx    on prospecting.outbound_targets (campaign_id, stage);
create index if not exists outbound_targets_lead_idx     on prospecting.outbound_targets (lead_id);
create index if not exists outbound_targets_phone_idx    on prospecting.outbound_targets (to_phone);
create index if not exists outbound_targets_callback_idx on prospecting.outbound_targets (callback_due_at)
    where called_back_at is null;
-- The send worker's hot query: next queued/sent row per line, oldest first.
create index if not exists outbound_targets_due_idx on prospecting.outbound_targets (campaign_id, from_line, step, updated_at)
    where stage in ('queued', 'sent');

-- ============================================================================
-- NURTURE VALUE TOUCHES
-- ============================================================================
--
-- The existing sequence (confirmation, VSL follow-up, day-before, T-15) is
-- logistics: it tells the prospect the meeting is real and when it is. This
-- table carries the VALUE layer on top, per Haynes: multiple substantive
-- touches per day between booking and meeting, so the prospect arrives already
-- educated instead of cold.
--
-- Rows are PLANNED at booking time and fired by a cron. Planning up front (as
-- opposed to deciding at send time) means the whole sequence is inspectable and
-- editable in the dashboard before a single message goes out, and a rebooked
-- meeting can have its remaining touches recomputed in one place.

create table if not exists prospecting.nurture_touches (
    id            bigserial primary key,
    lead_id       integer not null,
    -- Stable identity for the touch, e.g. 'value_market_research'. Used for
    -- idempotency and to re-plan without duplicating.
    step_key      text not null,
    channel       text not null,               -- 'email' | 'sms'
    scheduled_for timestamptz not null,

    subject       text,
    body          text,
    -- pending -> sent | skipped | failed. 'skipped' is a real outcome, not an
    -- error: a meeting booked for tomorrow morning legitimately drops the
    -- touches that would have landed before the booking.
    status        text not null default 'pending',
    sent_at       timestamptz,
    error         text,

    -- Which meeting this sequence belongs to. Per the rebooking postmortem,
    -- per-meeting state must NOT live on the lead alone, or a rebook silently
    -- inherits the previous run's "already sent" stamps and skips everything.
    meeting_at    timestamptz,

    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),

    unique (lead_id, step_key, channel, meeting_at)
);

create index if not exists nurture_touches_due_idx on prospecting.nurture_touches (scheduled_for)
    where status = 'pending';
create index if not exists nurture_touches_lead_idx on prospecting.nurture_touches (lead_id, meeting_at);

alter table prospecting.outbound_campaigns enable row level security;
alter table prospecting.outbound_targets   enable row level security;
alter table prospecting.nurture_touches    enable row level security;
