-- ============================================
-- STILO AI PARTNERS - Supabase Schema
-- ============================================
-- Run this in Supabase SQL Editor to set up the database.
-- Go to: https://supabase.com/dashboard > Your Project > SQL Editor
--
-- Agent codenames:
--   echo = AI Receptionist
--   ignite = Lead Response
--   revive = Customer Reactivation
--   scout = Lead Generator
--   forge = AI Website
--   signal = AI SEO (GEO)
--   oracle = Growth Intelligence
--   flux = Custom Automations

-- Leads table (pre-purchase / pre-booking capture)
-- Captures quiz results and contact info at the moment someone clicks
-- "Get Started Now" or "Book a Free Audit", BEFORE they hit Stripe or
-- confirm Calendly. This gives us retargeting data for drop-offs.
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  cta_type text not null check (cta_type in ('purchase','audit')),
  contact_name text,
  email text,
  phone text,
  business_name text,
  quiz_answers jsonb default '{}',
  tier text,
  selected_agents jsonb default '[]',
  estimated_price text,
  referrer text,
  page_url text,
  ip text,
  user_agent text,
  -- populated later when/if they convert
  converted boolean default false,
  converted_at timestamptz,
  stripe_session_id text,
  client_id uuid references public.clients(id) on delete set null
);

create index idx_leads_email on public.leads(email);
create index idx_leads_created_at on public.leads(created_at desc);
create index idx_leads_cta_type on public.leads(cta_type);
create index idx_leads_converted on public.leads(converted);

alter table public.leads enable row level security;
-- Only admins can read leads. No public read/write (API uses service role).
create policy "Admins can view all leads" on public.leads
  for select using (
    auth.jwt()->>'email' in ('remyleon11@gmail.com', 'stiloaiconsulting@gmail.com')
  );

-- Users table (extends Supabase auth.users)
create table public.clients (
  id uuid references auth.users primary key,
  business_name text not null,
  contact_name text not null,
  email text not null,
  phone text,
  business_type text,
  created_at timestamptz default now(),
  status text default 'active' -- active, paused, cancelled
);

-- Row Level Security: clients can only see their own data
alter table public.clients enable row level security;
create policy "Users can view own client record" on public.clients
  for select using (auth.uid() = id);
create policy "Users can update own client record" on public.clients
  for update using (auth.uid() = id);

-- Purchased agents
create table public.client_agents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  agent_type text not null, -- echo, ignite, revive, scout, forge, signal, oracle, flux
  status text default 'onboarding', -- onboarding, active, paused, cancelled
  stripe_subscription_id text,
  onboarding_progress jsonb default '{}',
  config jsonb default '{}',
  created_at timestamptz default now(),
  activated_at timestamptz
);

alter table public.client_agents enable row level security;
create policy "Users can view own agents" on public.client_agents
  for select using (client_id = auth.uid());
create policy "Users can update own agents" on public.client_agents
  for update using (client_id = auth.uid());

-- Onboarding steps tracking
create table public.onboarding_steps (
  id uuid primary key default gen_random_uuid(),
  client_agent_id uuid references public.client_agents(id) on delete cascade,
  step_number int not null,
  step_name text not null,
  status text default 'pending', -- pending, in_progress, completed
  data jsonb default '{}',
  completed_at timestamptz
);

alter table public.onboarding_steps enable row level security;
create policy "Users can view own onboarding steps" on public.onboarding_steps
  for select using (
    client_agent_id in (
      select id from public.client_agents where client_id = auth.uid()
    )
  );
create policy "Users can update own onboarding steps" on public.onboarding_steps
  for update using (
    client_agent_id in (
      select id from public.client_agents where client_id = auth.uid()
    )
  );

-- Agent metrics (for dashboard stats)
create table public.agent_metrics (
  id uuid primary key default gen_random_uuid(),
  client_agent_id uuid references public.client_agents(id) on delete cascade,
  metric_date date not null,
  metrics jsonb not null, -- flexible: {calls_handled: 45, leads_captured: 12, etc.}
  created_at timestamptz default now()
);

alter table public.agent_metrics enable row level security;
create policy "Users can view own metrics" on public.agent_metrics
  for select using (
    client_agent_id in (
      select id from public.client_agents where client_id = auth.uid()
    )
  );

-- Contracts
create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  contract_pdf_url text,
  signed_at timestamptz,
  status text default 'pending' -- pending, signed, cancelled
);

alter table public.contracts enable row level security;
create policy "Users can view own contracts" on public.contracts
  for select using (client_id = auth.uid());

-- ============================================
-- Admin role (for admin dashboard)
-- ============================================
-- Admin users can read all data. Set is_admin = true in the clients table
-- for Remy and any team members who need admin access.

alter table public.clients add column if not exists is_admin boolean default false;

-- Admin policies: admins can read all rows in every table.
-- Uses auth.jwt()->>'email' to avoid a circular reference — the old approach
-- (SELECT is_admin FROM clients WHERE id = auth.uid()) queries the same table
-- the policy lives on, causing infinite recursion and returning null.
create policy "Admins can view all clients" on public.clients
  for select using (
    auth.jwt()->>'email' in ('remyleon11@gmail.com', 'stiloaiconsulting@gmail.com')
    or auth.uid() = id
  );

create policy "Admins can view all agents" on public.client_agents
  for select using (
    auth.jwt()->>'email' in ('remyleon11@gmail.com', 'stiloaiconsulting@gmail.com')
    or client_id = auth.uid()
  );

create policy "Admins can view all onboarding" on public.onboarding_steps
  for select using (
    auth.jwt()->>'email' in ('remyleon11@gmail.com', 'stiloaiconsulting@gmail.com')
    or client_agent_id in (select id from public.client_agents where client_id = auth.uid())
  );

create policy "Admins can view all metrics" on public.agent_metrics
  for select using (
    auth.jwt()->>'email' in ('remyleon11@gmail.com', 'stiloaiconsulting@gmail.com')
    or client_agent_id in (select id from public.client_agents where client_id = auth.uid())
  );

create policy "Admins can view all contracts" on public.contracts
  for select using (
    auth.jwt()->>'email' in ('remyleon11@gmail.com', 'stiloaiconsulting@gmail.com')
    or client_id = auth.uid()
  );

-- Admins can also update any client_agents (pause, activate, configure)
create policy "Admins can update all agents" on public.client_agents
  for update using (
    auth.jwt()->>'email' in ('remyleon11@gmail.com', 'stiloaiconsulting@gmail.com')
    or client_id = auth.uid()
  );

-- Admins can insert new client_agents (deploy agents for clients)
create policy "Admins can insert agents" on public.client_agents
  for insert with check (
    auth.jwt()->>'email' in ('remyleon11@gmail.com', 'stiloaiconsulting@gmail.com')
  );

-- ============================================
-- Indexes for performance
-- ============================================
create index idx_client_agents_client_id on public.client_agents(client_id);
create index idx_onboarding_steps_agent_id on public.onboarding_steps(client_agent_id);
create index idx_agent_metrics_agent_date on public.agent_metrics(client_agent_id, metric_date);
create index idx_contracts_client_id on public.contracts(client_id);

-- ============================================
-- Helper function: create client on signup
-- ============================================
-- This trigger auto-creates a client record when a new user signs up.
-- The user's metadata (from the signup form) populates the fields.

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.clients (id, business_name, contact_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'business_name', ''),
    coalesce(new.raw_user_meta_data->>'contact_name', ''),
    new.email
  );
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
