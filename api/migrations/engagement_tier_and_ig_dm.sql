-- 2026-10-08 Engagement tier (cold / warm / hot) + Instagram DM queue.
-- Applied via Supabase MCP the same day.
--
-- engagement_tier is the REP-FACING temperature of a lead, separate from
-- prospect_tier / brief_tier (David's research ranking of how good a fit the
-- business is). Every lead starts cold. Any human signal (SMS reply, email
-- reply, video play, Instagram reply, missed call, decision maker reached)
-- promotes it to warm automatically; hot is set by a rep from the drawer.
-- Never auto-downgraded: a rep moves it back to cold by hand.

alter table prospecting.leads
  add column if not exists engagement_tier text not null default 'cold',
  add column if not exists engagement_tier_at timestamptz,
  add column if not exists engagement_tier_reason text,
  add column if not exists engagement_tier_by text,
  add column if not exists instagram_handle text,
  add column if not exists instagram_url text;

alter table prospecting.leads drop constraint if exists leads_engagement_tier_chk;
alter table prospecting.leads add constraint leads_engagement_tier_chk
  check (engagement_tier in ('cold','warm','hot'));

create index if not exists leads_engagement_tier_idx
  on prospecting.leads (engagement_tier, assigned_to) where engagement_tier <> 'cold';

-- One row per Instagram handle we intend to DM. lead_id is nullable: about a
-- third of the scraped clinics are not in the CRM yet. assigned_to is the rep
-- (sdr_users.email) whose account sends the DM. status moves
-- queued -> sent -> replied -> booked | not_interested | bot; a reply flips the
-- matching lead to warm through /api/prospects/ig-dm.
create table if not exists prospecting.ig_dm_queue (
  id             bigserial primary key,
  client_id      uuid,
  lead_id        integer references prospecting.leads(id) on delete set null,
  handle         text not null,
  instagram_url  text not null,
  business       text,
  first_name     text,
  city           text,
  lang           text not null default 'en',
  arm            text not null default 'A',           -- A = "hey" opener, B = laser question
  message_1      text not null,
  message_2      text,
  vsl_link       text,
  assigned_to    text,                                 -- sdr_users.email
  status         text not null default 'queued',
  step           smallint not null default 0,         -- last message sent (0..3)
  sent_at        timestamptz,
  sent_by        text,
  last_step_at   timestamptz,
  replied_at     timestamptz,
  reply_text     text,
  reply_kind     text,                                 -- named_laser | wants_info | not_interested | bot_or_desk | wants_call | wants_visit | other
  booked_at      timestamptz,
  notes          text,
  batch          text,                                 -- source file / import tag
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint ig_dm_queue_status_chk check (status in ('queued','sent','replied','booked','not_interested','bot','skipped'))
);
create unique index if not exists ig_dm_queue_handle_client_uq on prospecting.ig_dm_queue (handle, client_id);  -- handles are stored lowercase by the importer
create index if not exists ig_dm_queue_rep_status_idx on prospecting.ig_dm_queue (assigned_to, status);
create index if not exists ig_dm_queue_lead_idx on prospecting.ig_dm_queue (lead_id);

-- Backfill: anyone who already showed a human signal is warm today.
update prospecting.leads
   set engagement_tier = 'warm',
       engagement_tier_at = coalesce(hot_at, reply_received_at::timestamptz, now()),
       engagement_tier_reason = coalesce(hot_reason, 'replied to an email'),
       engagement_tier_by = 'backfill 2026-10-08'
 where engagement_tier = 'cold'
   and coalesce(stage,'NEW') not in ('CLOSED_LOST','CLOSED_WON')
   and (hot_at is not null or reply_received_at is not null);

update prospecting.leads l
   set engagement_tier = 'warm',
       engagement_tier_at = s.at,
       engagement_tier_reason = 'texted back',
       engagement_tier_by = 'backfill 2026-10-08'
  from (select lead_id, max(sent_at) at from prospecting.lead_messages where direction='inbound' and channel='sms' group by lead_id) s
 where s.lead_id = l.id and l.engagement_tier = 'cold' and coalesce(l.stage,'NEW') not in ('CLOSED_LOST','CLOSED_WON');

update prospecting.leads l
   set engagement_tier = 'warm',
       engagement_tier_at = c.at,
       engagement_tier_reason = 'reached the decision maker on a call',
       engagement_tier_by = 'backfill 2026-10-08'
  from (select lead_id, max(called_at) at from prospecting.lead_calls where decision_maker is true group by lead_id) c
 where c.lead_id = l.id and l.engagement_tier = 'cold' and coalesce(l.stage,'NEW') not in ('CLOSED_LOST','CLOSED_WON');

-- Interested callbacks and booked meetings are warm too.
update prospecting.leads
   set engagement_tier = 'warm',
       engagement_tier_at = coalesce(last_called_at::timestamptz, now()),
       engagement_tier_reason = 'said call back / booked',
       engagement_tier_by = 'backfill 2026-10-08'
 where engagement_tier = 'cold'
   and coalesce(stage,'NEW') not in ('CLOSED_LOST','CLOSED_WON')
   and last_called_outcome in ('callback_requested','interested_followup','booked_meeting');
-- 2026-10-08 debounce stamp for the warm-lead group text (see _hot.js)
alter table prospecting.leads add column if not exists hot_alert_sent_at timestamptz;

-- 2026-10-08 (afternoon) Facebook channel on the DM queue, escalation stamp, team chat
alter table prospecting.ig_dm_queue add column if not exists channel text not null default 'instagram';
alter table prospecting.ig_dm_queue drop constraint if exists ig_dm_queue_channel_chk;
alter table prospecting.ig_dm_queue add constraint ig_dm_queue_channel_chk check (channel in ('instagram','facebook'));
drop index if exists prospecting.ig_dm_queue_handle_client_uq;
create unique index if not exists ig_dm_queue_handle_client_uq on prospecting.ig_dm_queue (channel, handle, client_id);
alter table prospecting.leads add column if not exists facebook_url text, add column if not exists hot_escalated_at timestamptz;
alter table public.support_threads add column if not exists peer_key text;
create unique index if not exists support_threads_peer_key_uq on public.support_threads (peer_key) where peer_key is not null;
alter table public.support_messages add column if not exists sender_email text;

-- 2026-10-08 cap of 3 team texts per lead between calls
alter table prospecting.leads add column if not exists hot_alert_count smallint not null default 0, add column if not exists hot_alert_count_since timestamptz;

-- 2026-10-08 Facebook groups per rep + post log (see api/prospects/fb-groups.js)
create table if not exists prospecting.fb_groups (id bigserial primary key, name text not null, url text not null, members integer, privacy text, rules text, language text not null default 'en', geo text, audience text not null default 'blason', assigned_to text, status text not null default 'to_join', joined_at timestamptz, notes text, source text, created_by text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), constraint fb_groups_audience_chk check (audience in ('blason','stilo')), constraint fb_groups_status_chk check (status in ('to_join','pending','joined','left','rejected')));
create unique index if not exists fb_groups_url_uq on prospecting.fb_groups (url);  -- the API lowercases urls
create table if not exists prospecting.fb_group_posts (id bigserial primary key, group_id bigint references prospecting.fb_groups(id) on delete cascade, posted_by text not null, posted_at timestamptz not null default now(), copy text, reactions integer not null default 0, comments integer not null default 0, dms_sent integer not null default 0, note text);
