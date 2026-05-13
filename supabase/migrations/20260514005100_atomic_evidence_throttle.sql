-- Atomic anon-insert throttle.
--
-- Pre-v5 the BEFORE-INSERT trigger evidence_throttle_anon_insert ran a
-- SELECT FOR UPDATE on edge_rate_limit followed by a bare INSERT when the
-- row didn't exist.  FOR UPDATE on a non-existent row takes no lock; two
-- concurrent anon submissions from the same fresh IP both hit the
-- v_window IS NULL branch and the loser of the unique-constraint race
-- bubbled an unhandled duplicate-key exception out of the trigger,
-- rolling back the user's evidence INSERT entirely.
--
-- The check_and_bump_rate_limit RPC (introduced in 20260514004100 and
-- hardened in 20260514005200) already serializes through a single
-- INSERT ... ON CONFLICT DO UPDATE.  Reuse it from the trigger instead
-- of reimplementing the same SELECT/INSERT/UPDATE pattern.
--
-- Behaviour preserved:
--   * Service-role and authenticated users bypass (same role check).
--   * 5 inserts per IP per hour, same key format (ev_insert:<ip>).
--   * Exception raised with ERRCODE 54000 only when the throttle truly
--     trips — never on a race.

CREATE OR REPLACE FUNCTION public.evidence_throttle_anon_insert()
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
  v_allowed  boolean;
  v_count    integer;
  v_limit    constant integer := 5;
  v_window_s constant integer := 3600;
BEGIN
  -- Service role and authenticated users bypass.  Only anon is throttled.
  IF v_role IS DISTINCT FROM 'anon' THEN
    RETURN NEW;
  END IF;

  v_ip  := split_part(v_ip, ',', 1);
  v_key := 'ev_insert:' || v_ip;

  -- Single atomic round trip — the RPC handles window-roll, increment,
  -- and reject decision inside one INSERT ... ON CONFLICT DO UPDATE.
  SELECT allowed, current_count
    INTO v_allowed, v_count
    FROM public.check_and_bump_rate_limit(v_key, v_window_s, v_limit);

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Submission rate limit exceeded — try again later'
      USING ERRCODE = '54000';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.evidence_throttle_anon_insert()
  FROM anon, authenticated, public;

-- Trigger already exists from 20260514001300; CREATE OR REPLACE FUNCTION
-- is enough to swap the body without touching the trigger binding.
