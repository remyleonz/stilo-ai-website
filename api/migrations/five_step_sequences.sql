-- 2026-09-28. Five-step email and SMS sequences. Additive only.
-- Applied to prod (zsrskphpvgautfgklgxf) on 2026-09-28.
alter table prospecting.leads
  add column if not exists email_5_sent_at timestamptz,
  add column if not exists email_5_status text;
alter table prospecting.outbound_targets
  add column if not exists step4_body text,
  add column if not exists step4_sent_at timestamptz,
  add column if not exists step5_body text,
  add column if not exists step5_sent_at timestamptz;
-- 3 is what every campaign did before this. A campaign opts in to 5:
--   update prospecting.outbound_campaigns set max_steps = 5 where id = 4;
alter table prospecting.outbound_campaigns
  add column if not exists max_steps integer not null default 3;
