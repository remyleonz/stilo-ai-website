-- 2026-10-02: Blason VSL landing page funnel.
--
-- Two tables, both in public, both service-role only (RLS on, no policies, so
-- the anon key cannot read or write them; the public handlers use the service
-- key server-side).
--
-- funnel_events: one row per thing a visitor did on the page. Keyed by a
-- browser session_id (one tab visit) and a visitor_id (localStorage, survives
-- return visits). lead_id is filled when the URL carried a VALID signed ?lid=&t=
-- (same HMAC as api/public/_token.js) or after the visitor submitted the form.
-- This is what "track every step of the quiz" and "call anyone who even visited
-- the page" read from. Views and plays are ALSO dual-written to public.vsl_events
-- so the existing Sales-tab VSL card and vsl-watch-alerts keep working.
--
-- funnel_submissions: one row per contact form submit (name, cell, email,
-- answers, preferred path). The lead itself is upserted into prospecting.leads
-- with client_id = Blason; this table keeps the raw answers and the exact
-- moment, which the lead row would flatten.

create table if not exists public.funnel_events (
    id            bigserial primary key,
    created_at    timestamptz not null default now(),
    site          text not null,                 -- 'blason'
    session_id    text,
    visitor_id    text,
    lead_id       integer,                       -- prospecting.leads.id, verified or post-submit
    lead_claimed  boolean not null default false,-- true only when ?lid&t verified or submit happened
    event         text not null,                 -- page_view, video_play, video_progress, quiz_start, quiz_step, quiz_complete, contact_submitted, calendar_open, booking_confirmed, cta_click
    step          smallint,                      -- quiz step number for quiz_step; pct for video_progress
    answer        text,                          -- the chosen option key for quiz_step
    meta          jsonb,
    path          text,
    referrer      text,
    utm_source    text,
    utm_medium    text,
    utm_campaign  text,
    lang          text,
    ua            text,
    ip_hash       text                           -- sha1(ip + daily salt), never the raw ip
);
create index if not exists funnel_events_site_created_idx on public.funnel_events (site, created_at desc);
create index if not exists funnel_events_session_idx on public.funnel_events (session_id);
create index if not exists funnel_events_lead_idx on public.funnel_events (lead_id) where lead_id is not null;
create index if not exists funnel_events_visitor_idx on public.funnel_events (visitor_id) where visitor_id is not null;

create table if not exists public.funnel_submissions (
    id            bigserial primary key,
    created_at    timestamptz not null default now(),
    site          text not null,
    session_id    text,
    visitor_id    text,
    lead_id       integer,
    lead_created  boolean not null default false,  -- true when the submit created a brand-new lead row
    name          text,
    business      text,
    phone         text,
    phone_e164    text,
    email         text,
    lang          text,
    segment       text,        -- quiz Q1
    interest      text,        -- quiz Q2
    medical       text,        -- quiz Q3
    timeline      text,        -- quiz Q4
    path_pref     text,        -- 'showroom' | 'call'
    answers       jsonb,
    booked_at     timestamptz,
    meeting_at    timestamptz,
    ua            text,
    ip_hash       text
);
create index if not exists funnel_submissions_site_created_idx on public.funnel_submissions (site, created_at desc);
create index if not exists funnel_submissions_lead_idx on public.funnel_submissions (lead_id) where lead_id is not null;

alter table public.funnel_events enable row level security;
alter table public.funnel_submissions enable row level security;

-- 2026-10-02 (later the same day): the quiz was reordered after a closer's
-- review. "Business type" and "timeline" gave way to "have you been quoted"
-- and "what's driving it", which are what the September call transcripts said
-- actually predicted a booking. The old columns stay (nullable) for the rows
-- that already used them.
alter table public.funnel_submissions add column if not exists quoted text;
alter table public.funnel_submissions add column if not exists motive text;
