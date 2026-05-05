-- ============================================
-- Enable Supabase Realtime on prospect tables
-- ============================================
-- The admin dashboard subscribes to these tables via the @supabase/supabase-js
-- realtime client (websocket). When the OpenPhone webhook writes new call
-- rows or flips a prospect's status, the dashboard receives a push event in
-- milliseconds — no polling, and the update is delivered even if the user
-- closed the tab during the call (the change persists; next page load shows
-- it; if a tab is open elsewhere it updates live).
--
-- The realtime infrastructure already runs on Supabase; tables just need to
-- be added to the supabase_realtime publication.
--
-- Run in Supabase SQL Editor against the stilo-ai-partners project.

alter publication supabase_realtime add table public.prospects;
alter publication supabase_realtime add table public.prospect_calls;
