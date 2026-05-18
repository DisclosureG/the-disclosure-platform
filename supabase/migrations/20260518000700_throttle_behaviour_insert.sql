-- Throttle anon submissions to public.behaviour. Mirrors
-- evidence_throttle_anon_insert from 20260514001300; key prefix 'bh_insert:'
-- so the new trigger shares public.edge_rate_limit with evidence but counts
-- separately. Limit: 5 submissions per IP per hour, service-role bypass.

CREATE OR REPLACE FUNCTION public.behaviour_throttle_anon_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_role     text := current_setting('request.jwt.claim.role', true);
  v_ip       text := coalesce(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for',
                              current_setting('request.headers', true)::jsonb ->> 'cf-connecting-ip',
                              'anon-no-ip');
  v_key      text;
  v_window   timestamptz;
  v_count    integer;
  v_limit    constant integer := 5;
  v_window_s constant integer := 3600;
BEGIN
  -- Service role and authenticated users bypass.
  IF v_role IS DISTINCT FROM 'anon' THEN
    RETURN NEW;
  END IF;

  v_ip  := split_part(v_ip, ',', 1);
  v_key := 'bh_insert:' || v_ip;

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

DROP TRIGGER IF EXISTS behaviour_throttle_anon_insert ON public.behaviour;
CREATE TRIGGER behaviour_throttle_anon_insert
  BEFORE INSERT ON public.behaviour
  FOR EACH ROW
  EXECUTE FUNCTION public.behaviour_throttle_anon_insert();

REVOKE EXECUTE ON FUNCTION public.behaviour_throttle_anon_insert()
  FROM anon, authenticated, public;
