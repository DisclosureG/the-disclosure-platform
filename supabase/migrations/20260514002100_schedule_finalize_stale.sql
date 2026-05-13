-- Schedule finalize_stale_evidence on pg_cron so pending rows past 30 days
-- auto-lapse and contested rows past 21 days auto-resolve without an external
-- scheduler.  Runs hourly — finer cadence buys nothing for day-scale windows
-- and reduces unnecessary work.

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'finalize-stale-evidence-hourly') THEN
    PERFORM cron.schedule(
      'finalize-stale-evidence-hourly',
      '0 * * * *',
      $$SELECT public.finalize_stale_evidence();$$
    );
  END IF;
END $$;
