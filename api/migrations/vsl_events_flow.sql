-- Split public.vsl_events into its two real funnels.
--
-- Two completely different campaigns land on the same /agents/<slug> page, and
-- until now every event from both went into one undifferentiated pile:
--
--   1. 'campaign' — the cold VSL blast (api/prospects/vsl-campaign.js). Plain
--      text, no pixel, link carries ?lid. Audience: never-contacted leads.
--   2. 'confirm'  — the post-booking "confirm your meeting" email/SMS
--      (api/prospects/send-confirmations.js). Link carries &confirm=1.
--      Audience: people who already booked a closing call.
--
-- Mixing them makes both meaningless: a cold prospect who watches the video is
-- a completely different event from a booked prospect confirming attendance.
--
-- 'organic' = landed on a VSL page with neither marker (direct, nav, referral).

alter table public.vsl_events add column if not exists flow text;

-- ---------------------------------------------------------------------------
-- Backfill. Safe because the two audiences barely overlap: vsl-campaign.js
-- excludes stage='MEETING_BOOKED', and confirm emails only go to booked leads.
-- Exactly one lead is in both (campaigned first, booked later), so view/play
-- for that lead is disambiguated by timestamp against the confirm send.
-- ---------------------------------------------------------------------------

-- These three events only ever fire in confirm mode: confirm_open/confirm come
-- from agents/_confirm.js (which returns early unless ?confirm=1), and the
-- email_open pixel exists only in the confirmation email's HTML.
update public.vsl_events
   set flow = 'confirm'
 where flow is null
   and event in ('confirm_open', 'confirm', 'email_open');

-- view/play for a lead at or after we sent them a confirmation email.
update public.vsl_events v
   set flow = 'confirm'
  from prospecting.leads l
 where v.flow is null
   and v.lead_id = l.id
   and l.meeting_confirmation_sent_at is not null
   and v.created_at >= l.meeting_confirmation_sent_at;

-- Everything else from a lead we cold-campaigned.
update public.vsl_events v
   set flow = 'campaign'
 where v.flow is null
   and v.lead_id is not null
   and exists (
     select 1 from prospecting.lead_messages m
      where m.lead_id = v.lead_id and m.variant = 'vsl_campaign'
   );

update public.vsl_events set flow = 'organic' where flow is null;

-- ---------------------------------------------------------------------------
-- The client sends `agent` by reading data-agent off the .vsl-play button. When
-- that lookup returns null (scanners and partial-JS clients that still run the
-- tracker) the event landed with agent=null and fell out of the per-agent table
-- while still inflating the totals. The slug is always in the path, so recover
-- it. vsl-event.js now does the same derivation on write.
-- ---------------------------------------------------------------------------
update public.vsl_events
   set agent = substring(path from '^/agents/([a-z0-9-]+)')
 where agent is null
   and path ~ '^/agents/[a-z0-9-]+';

create index if not exists vsl_events_flow_created_idx on public.vsl_events (flow, created_at desc);
create index if not exists vsl_events_lead_idx on public.vsl_events (lead_id) where lead_id is not null;
