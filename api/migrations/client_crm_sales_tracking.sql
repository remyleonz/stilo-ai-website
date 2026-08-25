-- Applied to prod via Supabase MCP on 2026-08-25 (Blason Spa Equipment onboarding).
-- Client CRM for commission-based sales-agency engagements.

alter table public.clients
  add column if not exists engagement_model text,
  add column if not exists commission_pct numeric(5,2);

alter table public.sdr_users
  add column if not exists client_id uuid references public.clients(id);

create table if not exists public.client_sales (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id),
  lead_id integer,
  sale_date date not null default current_date,
  buyer_name text,
  description text not null,
  items jsonb,
  sale_amount_cents bigint not null check (sale_amount_cents > 0),
  commission_pct numeric(5,2) not null,
  commission_cents bigint not null,
  status text not null default 'reported' check (status in ('reported','invoiced','paid')),
  invoice_ref text,
  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.client_sales enable row level security;

create index if not exists idx_client_sales_client on public.client_sales(client_id, sale_date desc);
create index if not exists idx_leads_client_id on prospecting.leads(client_id) where client_id is not null;
