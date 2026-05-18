-- Rename chain-indexer → chain-indexer-evidence.
--
-- Symmetric with the alignment-side rename in 20260518110000. The two
-- archives now have parallel function names: chain-indexer-evidence and
-- chain-indexer-alignment. The renamed edge function is deployed
-- separately; this migration retires the old cron schedule + invoker and
-- stands up the new one.
--
-- Brief downtime (≤1 minute between cron ticks) is acceptable — the
-- indexer's chain_event_cursor resumes from the last processed block, so
-- no events are lost.

CREATE OR REPLACE FUNCTION public.invoke_chain_indexer_evidence()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_req bigint;
BEGIN
  SELECT net.http_post(
    url     := 'https://vkheezuilhhccszwfuaz.supabase.co/functions/v1/chain-indexer-evidence',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_req;
  RETURN v_req;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.invoke_chain_indexer_evidence() FROM anon, authenticated, public;

-- Swap cron jobs: unschedule any pre-existing variant (jobname has historically
-- been either 'chain-indexer' or 'chain-indexer-every-minute' depending on
-- migration vintage) and schedule the new one. Both names are checked so this
-- migration leaves a clean state regardless of which path got there first.
DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'chain-indexer-every-minute') THEN
    PERFORM cron.unschedule('chain-indexer-every-minute');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'chain-indexer') THEN
    PERFORM cron.unschedule('chain-indexer');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'chain-indexer-evidence-every-minute') THEN
    PERFORM cron.schedule(
      'chain-indexer-evidence-every-minute',
      '* * * * *',
      'SELECT public.invoke_chain_indexer_evidence();'
    );
  END IF;
END
$migration$;

-- Retire the old invoker. It has no remaining caller after the cron swap.
DROP FUNCTION IF EXISTS public.invoke_chain_indexer();

-- Clear the stale heartbeat row keyed by the old function name.
DELETE FROM public.edge_function_heartbeat
 WHERE function_name = 'chain-indexer';
