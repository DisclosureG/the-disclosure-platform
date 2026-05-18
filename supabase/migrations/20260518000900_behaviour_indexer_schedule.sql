-- Schedule the behaviour-side edge functions on pg_cron via pg_net.
-- Reuses the vault-stored project_url and service_role_key set up in
-- 20260514001400 — no new vault entries needed.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Hardcode the URL instead of reading from vault. Matches the working
-- evidence invoker (invoke_chain_indexer) — the vault entries
-- 'project_url' / 'service_role_key' are not provisioned on this project,
-- so any function depending on them silently returns NULL and the cron
-- fires no HTTP request.

CREATE OR REPLACE FUNCTION public.invoke_chain_indexer_behaviour()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_req bigint;
BEGIN
  SELECT net.http_post(
    url     := 'https://vkheezuilhhccszwfuaz.supabase.co/functions/v1/chain-indexer-behaviour',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_req;
  RETURN v_req;
END;
$function$;

CREATE OR REPLACE FUNCTION public.invoke_audit_behaviour_hash()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_req bigint;
BEGIN
  SELECT net.http_post(
    url     := 'https://vkheezuilhhccszwfuaz.supabase.co/functions/v1/audit-behaviour-hash',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_req;
  RETURN v_req;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.invoke_chain_indexer_behaviour() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.invoke_audit_behaviour_hash()    FROM anon, authenticated, public;

-- Schedules: indexer every minute (matches evidence cadence), audit daily at
-- 03:23 UTC (offset 6 minutes from evidence audit's 03:17 to spread load).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'chain-indexer-behaviour-every-minute') THEN
    PERFORM cron.schedule(
      'chain-indexer-behaviour-every-minute',
      '* * * * *',
      $$SELECT public.invoke_chain_indexer_behaviour();$$
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'audit-behaviour-hash-daily') THEN
    PERFORM cron.schedule(
      'audit-behaviour-hash-daily',
      '23 3 * * *',
      $$SELECT public.invoke_audit_behaviour_hash();$$
    );
  END IF;
END $$;
