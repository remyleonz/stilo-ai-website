-- ============================================
-- Support inbox: threads + messages
-- ============================================
-- Backs the in-dashboard support channel between clients and Remy/admins.
-- Every thread is owned by one client and may be tagged to a specific
-- client_agents row (e.g. "issue with my ECHO setup"). Threads with a
-- null client_agent_id are general account questions.
--
-- Read by:
--   sites/stilo-ai/api/support/threads.js   (list + create)
--   sites/stilo-ai/api/support/messages.js  (append + list)
--   sites/stilo-ai/app/index.html           (client side inbox + per-agent button)
--   sites/stilo-ai/admin/index.html         (admin support inbox)
--
-- Run in Supabase SQL Editor against the stilo-ai-partners project.

create table if not exists public.support_threads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  client_agent_id uuid references public.client_agents(id) on delete set null,
  subject text,
  status text not null default 'open' check (status in ('open','resolved')),
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create index if not exists support_threads_client_idx
  on public.support_threads(client_id, last_message_at desc);

create index if not exists support_threads_agent_idx
  on public.support_threads(client_agent_id)
  where client_agent_id is not null;

create index if not exists support_threads_status_idx
  on public.support_threads(status, last_message_at desc);

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.support_threads(id) on delete cascade,
  sender_type text not null check (sender_type in ('client','admin','system')),
  sender_id uuid,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists support_messages_thread_idx
  on public.support_messages(thread_id, created_at);

-- RLS: clients see only their own threads + messages. Admins see all.
alter table public.support_threads enable row level security;
alter table public.support_messages enable row level security;

create policy "Clients view own threads" on public.support_threads
  for select using (client_id = auth.uid());

create policy "Clients create own threads" on public.support_threads
  for insert with check (client_id = auth.uid());

create policy "Clients update own threads" on public.support_threads
  for update using (client_id = auth.uid());

create policy "Admins view all threads" on public.support_threads
  for select using (
    auth.jwt()->>'email' in ('remyleon11@gmail.com', 'stiloaiconsulting@gmail.com', 'remyleon@stiloaipartners.com', 'davidcoira@stiloaipartners.com')
  );

create policy "Admins update all threads" on public.support_threads
  for update using (
    auth.jwt()->>'email' in ('remyleon11@gmail.com', 'stiloaiconsulting@gmail.com', 'remyleon@stiloaipartners.com', 'davidcoira@stiloaipartners.com')
  );

create policy "Clients view own messages" on public.support_messages
  for select using (
    thread_id in (select id from public.support_threads where client_id = auth.uid())
  );

create policy "Clients append own messages" on public.support_messages
  for insert with check (
    sender_type = 'client'
    and thread_id in (select id from public.support_threads where client_id = auth.uid())
  );

create policy "Admins view all messages" on public.support_messages
  for select using (
    auth.jwt()->>'email' in ('remyleon11@gmail.com', 'stiloaiconsulting@gmail.com', 'remyleon@stiloaipartners.com', 'davidcoira@stiloaipartners.com')
  );

create policy "Admins append messages" on public.support_messages
  for insert with check (
    auth.jwt()->>'email' in ('remyleon11@gmail.com', 'stiloaiconsulting@gmail.com', 'remyleon@stiloaipartners.com', 'davidcoira@stiloaipartners.com')
  );

-- Bump last_message_at on the parent thread whenever a new message lands,
-- so the inbox can sort threads by recency without a join.
create or replace function public.touch_support_thread()
returns trigger as $$
begin
  update public.support_threads
    set last_message_at = new.created_at
    where id = new.thread_id;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists support_messages_touch_thread on public.support_messages;
create trigger support_messages_touch_thread
  after insert on public.support_messages
  for each row execute procedure public.touch_support_thread();
