-- Indexer heartbeat: a row updated on every successful chain-indexer run so
-- external monitors can detect a silently-failing cron job.  Without this,
-- the indexer can die for hours before anyone notices (and once it's stale
-- by >50k blocks, events are lost without manual backfill).

CREATE TABLE IF NOT EXISTS public.edge_function_heartbeat (
  function_name text PRIMARY KEY,
  last_success  timestamptz NOT NULL DEFAULT now(),
  last_attempt  timestamptz NOT NULL DEFAULT now(),
  last_status   text,
  last_payload  jsonb
);

ALTER TABLE public.edge_function_heartbeat ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS heartbeat_read ON public.edge_function_heartbeat;
CREATE POLICY heartbeat_read
  ON public.edge_function_heartbeat FOR SELECT
  USING (true);
-- Service-role-only writes.
