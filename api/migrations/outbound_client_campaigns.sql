-- Outbound SMS campaigns can belong to a client, and a campaign may only ever
-- touch its own pool.
--
-- Until now outbound-enqueue.js selected from prospecting.leads with no client
-- filter at all. Nothing had gone wrong, because no client lead had ever been
-- enqueued, but a 'scripted' enqueue on a STILO campaign would happily pull a
-- Blason lead in and text it STILO copy. Every other client-content path in the
-- codebase guards on client_id (confirmations, day-before, nurture planner, VSL
-- follow-up, the cold email sequence, draft-email); outbound was the one hole,
-- and it is the channel that reaches a phone.
--
-- The fix is not "STILO campaigns skip client leads". It is that a campaign
-- DECLARES which pool it serves, and the enqueue matches on it exactly:
--
--   client_id IS NULL  -> STILO's own book. Enqueues only leads.client_id IS NULL.
--   client_id = <uuid> -> that client's pool. Enqueues only that client's leads.
--
-- Null is the default, so every existing campaign keeps its current meaning and
-- gains the guard for free.
alter table prospecting.outbound_campaigns
    add column if not exists client_id uuid references public.clients(id);

comment on column prospecting.outbound_campaigns.client_id is
    'Which lead pool this campaign serves. NULL = STILO''s own book. Set = that client''s leads only. outbound-enqueue.js matches leads.client_id against this exactly, so a campaign can never text another pool.';

create index if not exists outbound_campaigns_client_id_idx
    on prospecting.outbound_campaigns (client_id);
