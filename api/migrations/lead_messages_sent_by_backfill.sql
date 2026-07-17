-- Attribute historical auto-sent emails to the owning rep.
--
-- The auto VSL blast (vsl-campaign.js) and the auto meeting confirmation
-- (send-confirmations.js) used to write lead_messages rows with sent_by = null,
-- so they never appeared on any rep's Emailed tab. Both senders now stamp
-- sent_by going forward; this backfills the rows already written.
--
-- OPTIONAL: api/prospects/emailed.js also scopes null-sent_by automated rows to
-- the rep by lead ownership at query time, so the tab is correct with or without
-- this backfill. Run it to keep the column itself honest (exports, ad-hoc SQL).

update prospecting.lead_messages m
   set sent_by = l.assigned_to
  from prospecting.leads l
 where m.lead_id = l.id
   and m.sent_by is null
   and m.variant in ('vsl_campaign', 'vsl_warm_a', 'vsl_warm_b')
   and l.assigned_to is not null;

update prospecting.lead_messages m
   set sent_by = l.meeting_booked_by_sdr
  from prospecting.leads l
 where m.lead_id = l.id
   and m.sent_by is null
   and m.variant = 'meeting_confirm'
   and l.meeting_booked_by_sdr is not null;
