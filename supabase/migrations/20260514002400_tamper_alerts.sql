-- Tamper alerts: a table the audit edge function writes to when it finds an
-- evidence row whose stored content_hash no longer matches the canonical hash
-- of its (title, source, year, excerpt, link, tier, pillar_id).
--
-- Keccak256 is not a Postgres builtin (digest(..., 'sha3-256') is NIST SHA3,
-- not Ethereum keccak), so the comparison runs in JS inside the `audit-content-
-- hash` edge function which is scheduled by pg_cron via pg_net (mirrors the
-- chain-indexer schedule pattern).

CREATE TABLE IF NOT EXISTS public.tamper_alerts (
  id              bigserial PRIMARY KEY,
  evidence_id     uuid       NOT NULL REFERENCES public.evidence(id) ON DELETE CASCADE,
  expected_hash   text       NOT NULL,
  stored_hash     text       NOT NULL,
  detected_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolution_note text
);

CREATE INDEX IF NOT EXISTS tamper_alerts_open_idx
  ON public.tamper_alerts (detected_at DESC)
  WHERE resolved_at IS NULL;

ALTER TABLE public.tamper_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tamper_alerts_read ON public.tamper_alerts;
CREATE POLICY tamper_alerts_read
  ON public.tamper_alerts FOR SELECT
  USING (true);
-- Writes only via service role.

CREATE OR REPLACE FUNCTION public.invoke_audit_content_hash()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'vault'
AS $function$
DECLARE
  v_url text;
  v_key text;
  v_req bigint;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE NOTICE 'audit-content-hash secrets missing; skipping invocation';
    RETURN NULL;
  END IF;

  SELECT net.http_post(
    url     := v_url || '/functions/v1/audit-content-hash',
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

REVOKE EXECUTE ON FUNCTION public.invoke_audit_content_hash() FROM anon, authenticated, public;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'audit-content-hash-daily') THEN
    PERFORM cron.schedule(
      'audit-content-hash-daily',
      '17 3 * * *',  -- 03:17 UTC daily, off-peak
      $$SELECT public.invoke_audit_content_hash();$$
    );
  END IF;
END $$;
