-- Add rep-e (Melanye Altuve, hired 2026-08-25) to the folder->owner map.
--
-- This function is the ONLY place that maps a brief folder to an OWNER; the
-- other eight consumers only need the folder to exist. Without rep-e here,
-- David's first push to that folder would flag the leads as scripted and then
-- leave them on whoever the insert trigger happened to pick, and the hourly
-- pg_cron reconcile would never route them to her. Her board would read 0 with
-- 250 briefed leads sitting in storage.
create or replace function prospecting.reconcile_brief_assignments()
returns integer
language plpgsql
security definer
as $function$
declare
  changed integer;
begin
  -- Folder -> rep map. THIS MAP EXISTS IN NINE PLACES (see wiki:
  -- brief_folder_map_six_places, which undercounts; the other eight are
  -- sync-scripts.js, cold-call-script.js, backfill_brief_tier.js,
  -- backfill_script_flag.js, audit_sdr_assignments.js,
  -- audit_board_contamination.js, audit_david_artifacts.js and
  -- repair_new_niche_queues.js). This function is the only one that maps a
  -- folder to an OWNER; the rest only need the folder to exist.
  --
  -- 2026-08-20: rep-d points back at GEORGE, reversing the 08-19 offboarding
  -- routing. The offboarding runbook ("a departed rep's book goes to the owner")
  -- was applied to the wrong folder. rep-d was never Marcus's book: David
  -- created it FOR George on 2026-08-03 (32 briefs, then 150 more on 08-05)
  -- while George's sdr_users note still read "awaiting David's brief push".
  -- Marcus held it for eight days after the 08-11 George/Marcus swap, and his
  -- own note says he was to inherit rep-a, not rep-d. When he left, 243 of
  -- George's leads followed his exit to the owner line.
  --
  -- The symptom: George's board read 53. All 53 had no brief file in ANY folder
  -- (residue of Luke's old rep-a book, still flagged because sync-scripts is
  -- enable-only), and rep-a has held zero objects all August, so the hourly
  -- reconcile had nothing to give him. A working rep sat at 53 dead leads while
  -- his 207 board-ready ones sat on the owner's board undialed.
  --
  -- rep-a stays pointed at George too. It is empty today, but it costs nothing
  -- and means a future David push there still reaches him.
  --
  -- 2026-08-24: rep-e added for Melanye Altuve, who started 2026-08-25. The
  -- folder holds nothing yet; it is mapped BEFORE David's first push precisely
  -- so the push does not land on nobody.
  --
  -- Do NOT point a folder at an inactive rep. outbound-enqueue drops any lead
  -- whose assigned_to has no active sdr_users row (held_back.no_rep_line), so a
  -- departed rep's book silently stops being textable or callable.
  --
  -- Historic context kept: leaving rep-a pointed at a departed rep at rank 2 is
  -- what silently pulled a manual reassignment back within the hour in August.
  with map(folder, email, rank) as (
    values ('rep-a','georgegutierrez446@gmail.com',1), -- George (was Luke, then unowned)
           ('rep-b','aleb1027@gmail.com',1),        -- Alejandro
           ('rep-c','ayesjorge911@gmail.com',1),    -- Jorge (inherited Jack's folder 2026-07-15)
           ('rep-d','georgegutierrez446@gmail.com',1), -- George's original book, back from the Marcus detour
           ('rep-e','melanyealtuve12@gmail.com',1), -- Melanye, hired 2026-08-25
           ('rl','remyleon@stiloaipartners.com',2), -- Remy owner line
           ('dc','davidcoira@stiloaipartners.com',2)-- David owner line
  ),
  briefs as (
    select split_part(o.name,'/',1) as folder,
           regexp_replace(lower(regexp_replace(split_part(o.name,'/',2),'-\d{4}-\d{2}-\d{2}\.md$','')),'[^a-z0-9]','','g') as norm_key
    from storage.objects o
    where o.bucket_id='cold-call-briefs'
      and split_part(o.name,'/',1) in ('rep-a','rep-b','rep-c','rep-d','rep-e','rl','dc')
    group by 1,2
  ),
  best as (
    select distinct on (b.norm_key) b.norm_key, m.email
    from briefs b join map m on m.folder = b.folder
    order by b.norm_key, m.rank
  ),
  target as (
    select l.id, x.email
    from prospecting.leads l
    join best x on x.norm_key = regexp_replace(lower(l.name),'[^a-z0-9]','','g')
    where l.stage = 'NEW'
      and l.last_called_at is null
      and coalesce(l.call_attempts,0) = 0
      and l.assigned_to is distinct from x.email
  )
  update prospecting.leads l
     set assigned_to = t.email, updated_at = now()
    from target t
   where l.id = t.id;
  get diagnostics changed = row_count;
  return changed;
end;
$function$;
