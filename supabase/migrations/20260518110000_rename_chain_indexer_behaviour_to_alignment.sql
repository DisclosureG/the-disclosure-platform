-- Rename chain-indexer-behaviour → chain-indexer-alignment.
--
-- Aligns the edge-function name with the user-facing "Alignment" archive
-- label. The renamed function is deployed separately via the Supabase
-- functions API; this migration retires the old cron schedule + invoker
-- and stands up the new one.
--
-- Brief downtime (≤1 minute between cron ticks) is acceptable — the
-- indexer's behaviour_chain_event_cursor resumes from the last processed
-- block, so no events are lost.

CREATE OR REPLACE FUNCTION public.invoke_chain_indexer_alignment()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_req bigint;
BEGIN
  SELECT net.http_post(
    url     := 'https://vkheezuilhhccszwfuaz.supabase.co/functions/v1/chain-indexer-alignment',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_req;
  RETURN v_req;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.invoke_chain_indexer_alignment() FROM anon, authenticated, public;

-- Swap cron jobs: unschedule old, schedule new under the new name.
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'chain-indexer-behaviour-every-minute') THEN
    PERFORM cron.unschedule('chain-indexer-behaviour-every-minute');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'chain-indexer-alignment-every-minute') THEN
    PERFORM cron.schedule(
      'chain-indexer-alignment-every-minute',
      '* * * * *',
      'SELECT public.invoke_chain_indexer_alignment();'
    );
  END IF;
END
$migration$;

-- Retire the old invoker. It has no remaining caller after the cron swap.
DROP FUNCTION IF EXISTS public.invoke_chain_indexer_behaviour();

-- Clear the stale heartbeat row keyed by the old function name. The OpsPanel
-- would otherwise show a perpetually-red dot for a function that no longer
-- runs. The new function will upsert its own row keyed by
-- 'chain-indexer-alignment' on its next tick.
DELETE FROM public.edge_function_heartbeat
 WHERE function_name = 'chain-indexer-behaviour';
