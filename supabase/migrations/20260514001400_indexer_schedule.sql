-- Wire the chain-indexer to pg_cron + pg_net so it runs every minute without
-- requiring an external scheduler.  Service-role auth lives in vault to avoid
-- baking the key into pg_cron's command text.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Operator must populate these once after deployment:
--   SELECT vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   SELECT vault.create_secret('<service-role-jwt>',                'service_role_key');
--
-- The pg_cron job below reads both at run time.

CREATE OR REPLACE FUNCTION public.invoke_chain_indexer()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_url   text;
  v_key   text;
  v_req   bigint;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE NOTICE 'chain-indexer secrets missing; skipping invocation';
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url     := v_url || '/functions/v1/chain-indexer',
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || v_key
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_req;
  RETURN v_req;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.invoke_chain_indexer() FROM anon, authenticated, public;

-- One-minute schedule.  pg_cron stores schedules per-database; idempotent
-- thanks to the SELECT-then-INSERT pattern.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'chain-indexer-every-minute') THEN
    PERFORM cron.schedule(
      'chain-indexer-every-minute',
      '* * * * *',
      $$SELECT public.invoke_chain_indexer();$$
    );
  END IF;
END $$;
