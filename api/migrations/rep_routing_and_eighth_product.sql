-- =====================================================================
-- Rep routing + 8th product + niche signals
-- =====================================================================
-- Applied to Supabase project zsrskphpvgautfgklgxf on 2026-05-26 via
-- the Supabase MCP. Source for this migration is David's 2026-05-26 email
-- and supersedes the 2026-05-20 reminder items.
--
-- matched_product_name is plain varchar — no enum migration required.
-- Sage can write 'AI Sales Agent' as a string directly.

alter table prospecting.leads
  add column if not exists rep_assignment text,                   -- 'A' | 'B' | 'C' | 'unassigned'
  add column if not exists tentative_rep_assignment text,         -- set at scrape-time from priority queue
  add column if not exists owner_direct_confirmed boolean,        -- owner_phone_source = owner_cell etc.
  add column if not exists chain_or_dso boolean,                  -- structural gatekeeper
  add column if not exists single_location_confirmed boolean,
  add column if not exists bilingual_owner text,                  -- 'en'|'es'|'en_es'|'other'|null
  add column if not exists recommended_language text,             -- 'en'|'es'
  add column if not exists customer_type text,                    -- 'b2b'|'b2c'|'mixed'
  add column if not exists sales_team_size integer,
  add column if not exists existing_sales_stack jsonb,            -- ['gong','outreach',...]
  add column if not exists dental_pms_vendor text,                -- 'dentrix'|'eaglesoft' (paired with has_dental_pms)
  add column if not exists pricing_band jsonb,                    -- { tier: 'standard'|'flex_up'|'flex_down', notes }
  -- David thought these were already added by /learnfromcc but they weren't.
  -- Adding them so Sage's writes don't fail.
  add column if not exists has_dental_pms boolean,
  add column if not exists medspa_subtype text;

create index if not exists idx_leads_rep_assignment    on prospecting.leads (rep_assignment);
create index if not exists idx_leads_customer_type     on prospecting.leads (customer_type);
create index if not exists idx_leads_chain_or_dso      on prospecting.leads (chain_or_dso) where chain_or_dso = true;
create index if not exists idx_leads_owner_direct      on prospecting.leads (owner_direct_confirmed) where owner_direct_confirmed = true;
create index if not exists idx_leads_recommended_lang  on prospecting.leads (recommended_language);
create index if not exists idx_leads_has_dental_pms    on prospecting.leads (has_dental_pms) where has_dental_pms = true;

-- ============================================
-- prospecting.lead_disqualifications
-- ============================================
-- Optional table from David's email — surface skipped leads alongside
-- attempted contacts so /learnfromcc can audit over-filtering.
create table if not exists prospecting.lead_disqualifications (
  id uuid primary key default gen_random_uuid(),
  lead_id integer references prospecting.leads(id) on delete cascade,
  business_name text,
  category text,
  reason text not null,
  evidence text,
  scraped_at timestamptz default now(),
  reviewable boolean default true,
  reviewed_by text,
  reviewed_at timestamptz
);

create index if not exists idx_disqual_reason       on prospecting.lead_disqualifications (reason);
create index if not exists idx_disqual_reviewable   on prospecting.lead_disqualifications (reviewable) where reviewable = true;
create index if not exists idx_disqual_lead         on prospecting.lead_disqualifications (lead_id);

alter table prospecting.lead_disqualifications enable row level security;
drop policy if exists "Admins read disqualifications" on prospecting.lead_disqualifications;
create policy "Admins read disqualifications" on prospecting.lead_disqualifications
  for select using (public.is_active_admin());

-- ============================================
-- prospecting.dialed_before_research view
-- ============================================
-- David's reminder item #3: "Audit query for leads dialed before Sage
-- research finished." Implemented as a view so /learnfromcc + the admin
-- dashboard can query it directly.
create or replace view prospecting.dialed_before_research as
select
  l.id,
  l.name as business_name,
  l.owner_name,
  l.owner_phone,
  l.assigned_to,
  l.created_at,
  min(lc.called_at) as first_call_at,
  count(lc.id) as call_attempts,
  (l.prospect_reasoning is null) as missing_reasoning,
  (l.matched_product_name is null) as missing_product
from prospecting.leads l
join prospecting.lead_calls lc on lc.lead_id = l.id
where l.prospect_reasoning is null or l.matched_product_name is null
group by l.id, l.name, l.owner_name, l.owner_phone, l.assigned_to, l.created_at, l.prospect_reasoning, l.matched_product_name
order by call_attempts desc, first_call_at asc;

-- ============================================
-- storage.buckets — cold-call-briefs
-- ============================================
-- Service role (Sage worker) writes; admins + matching SDR read.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types, created_at, updated_at)
values ('cold-call-briefs', 'cold-call-briefs', false, 5242880,
        array['text/markdown','text/plain','application/pdf','text/csv','application/octet-stream'],
        now(), now())
on conflict (id) do nothing;

-- RLS on storage.objects (already enabled by Supabase platform — just add policies)
drop policy if exists "Admins read cold-call-briefs" on storage.objects;
create policy "Admins read cold-call-briefs" on storage.objects
  for select using (
    bucket_id = 'cold-call-briefs' and public.is_active_admin()
  );

-- Mapping: A → jack, B → luke, C → alejandro. Updated 2026-05-26 to
-- match Remy's roster order. Trigger in this file uses the same mapping.
drop policy if exists "SDRs read own rep cold-call-briefs" on storage.objects;
create policy "SDRs read own rep cold-call-briefs" on storage.objects
  for select using (
    bucket_id = 'cold-call-briefs'
    and (auth.jwt() #>> '{app_metadata,role}') = 'sdr'
    and (
      (name like 'rep-a/%' and exists (select 1 from public.sdr_users s where s.auth_user_id = auth.uid() and s.sdr_key = 'jack'))
      or (name like 'rep-b/%' and exists (select 1 from public.sdr_users s where s.auth_user_id = auth.uid() and s.sdr_key = 'luke'))
      or (name like 'rep-c/%' and exists (select 1 from public.sdr_users s where s.auth_user_id = auth.uid() and s.sdr_key = 'alejandro'))
    )
  );
