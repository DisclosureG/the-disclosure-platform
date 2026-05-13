-- Drop the legacy service-role JWT dependency in invoke_chain_indexer().
--
-- The project moved to the new Supabase API key system (sb_publishable_ +
-- sb_secret_), which is not compatible with the `'Bearer ' || jwt` pattern
-- the original wrapper used. The edge function itself is now redeployed
-- with verify_jwt=false; gateway-level auth is replaced by the function's
-- own application-level guarantees (service-role DB writes for chain-indexer,
-- EIP-712 sig + tx-receipt verification for verify-attestation).
--
-- With no auth header required, the wrapper no longer needs to read from
-- vault. Project URL is hardcoded for this single-environment deployment;
-- change it here if you ever fork into a staging project.

CREATE OR REPLACE FUNCTION public.invoke_chain_indexer()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_req bigint;
BEGIN
  SELECT net.http_post(
    url     := 'https://vkheezuilhhccszwfuaz.supabase.co/functions/v1/chain-indexer',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) INTO v_req;
  RETURN v_req;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.invoke_chain_indexer() FROM anon, authenticated, public;
