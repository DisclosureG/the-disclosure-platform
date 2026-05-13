-- Throttle anon submissions to public.evidence.  Without this, anyone with the
-- publishable anon key can bulk-insert pending rows that never make it on-chain
-- but still bloat the table and the unchained-pending UI.
--
-- Strategy: a BEFORE-INSERT trigger that rate-limits by client IP using the
-- existing edge_rate_limit table.  Limit: 5 submissions per IP per hour.
-- Service role bypasses the trigger because we set a session flag.

ALTER TABLE public.evidence
  ADD COLUMN IF NOT EXISTS submitter_ip text;

CREATE OR REPLACE FUNCTION public.evidence_throttle_anon_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_role    text := current_setting('request.jwt.claim.role', true);
  v_ip      text := coalesce(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for',
                              current_setting('request.headers', true)::jsonb ->> 'cf-connecting-ip',
                              'anon-no-ip');
  v_key     text;
  v_window  timestamptz;
  v_count   integer;
  v_limit   constant integer := 5;
  v_window_s constant integer := 3600;
BEGIN
  -- Service role and authenticated users bypass.  Only anon is throttled.
  IF v_role IS DISTINCT FROM 'anon' THEN
    RETURN NEW;
  END IF;

  -- Keep IP off the public row by default; trigger uses it but the column
  -- stays NULL unless explicitly set by the service role.
  v_ip  := split_part(v_ip, ',', 1);
  v_key := 'ev_insert:' || v_ip;

  SELECT window_start, count INTO v_window, v_count
    FROM public.edge_rate_limit
   WHERE key = v_key
   FOR UPDATE;

  IF v_window IS NULL THEN
    INSERT INTO public.edge_rate_limit (key, window_start, count, updated_at)
      VALUES (v_key, NOW(), 1, NOW());
    RETURN NEW;
  END IF;

  IF EXTRACT(EPOCH FROM (NOW() - v_window)) > v_window_s THEN
    UPDATE public.edge_rate_limit
       SET window_start = NOW(), count = 1, updated_at = NOW()
     WHERE key = v_key;
    RETURN NEW;
  END IF;

  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'Submission rate limit exceeded — try again later'
      USING ERRCODE = '54000';
  END IF;

  UPDATE public.edge_rate_limit
     SET count = count + 1, updated_at = NOW()
   WHERE key = v_key;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS evidence_throttle_anon_insert ON public.evidence;
CREATE TRIGGER evidence_throttle_anon_insert
  BEFORE INSERT ON public.evidence
  FOR EACH ROW
  EXECUTE FUNCTION public.evidence_throttle_anon_insert();

REVOKE EXECUTE ON FUNCTION public.evidence_throttle_anon_insert()
  FROM anon, authenticated, public;
