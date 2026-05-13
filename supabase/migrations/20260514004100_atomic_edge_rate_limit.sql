-- Atomic rate-limit check.
--
-- The verify-attestation edge function previously did a SELECT-then-UPDATE
-- against edge_rate_limit across two HTTP round trips.  At the sliding-window
-- boundary, two concurrent requests both read elapsedS > 60 and both reset
-- count to 1, so the throttle could be sustained at 2 × RATE_LIMIT_MAX per
-- minute by riding the boundary.
--
-- This RPC takes FOR UPDATE on the row, decides window-roll vs. increment vs.
-- reject inside a single statement, and returns whether the request is
-- allowed plus the post-decision counter.  Edge function calls it via
-- supabase.rpc('check_and_bump_rate_limit', { ... }) — one round trip,
-- serialised through the row lock.

CREATE OR REPLACE FUNCTION public.check_and_bump_rate_limit(
  p_key       text,
  p_window_s  integer,
  p_max       integer
)
RETURNS TABLE (allowed boolean, current_count integer, window_start timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row    RECORD;
  v_now    timestamptz := NOW();
BEGIN
  -- Try to lock the existing row.  If it doesn't exist, insert it and
  -- return allowed=true with count=1.  The INSERT may race with another
  -- concurrent inserter — handle that with ON CONFLICT DO NOTHING then
  -- re-select FOR UPDATE.
  SELECT key, edge_rate_limit.window_start, count
    INTO v_row
    FROM public.edge_rate_limit
   WHERE key = p_key
   FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.edge_rate_limit (key, window_start, count, updated_at)
      VALUES (p_key, v_now, 1, v_now)
      ON CONFLICT (key) DO NOTHING;
    -- Re-fetch; if someone else inserted concurrently we'll see their row.
    SELECT key, edge_rate_limit.window_start, count
      INTO v_row
      FROM public.edge_rate_limit
     WHERE key = p_key
     FOR UPDATE;
    IF v_row.count <= 1 THEN
      RETURN QUERY SELECT TRUE, 1, v_row.window_start;
      RETURN;
    END IF;
  END IF;

  -- Window roll: if the existing window is stale, reset under the same lock.
  IF EXTRACT(EPOCH FROM (v_now - v_row.window_start)) > p_window_s THEN
    UPDATE public.edge_rate_limit
       SET window_start = v_now,
           count        = 1,
           updated_at   = v_now
     WHERE key = p_key;
    RETURN QUERY SELECT TRUE, 1, v_now;
    RETURN;
  END IF;

  -- Within the active window: throttle when over the cap, otherwise bump.
  IF v_row.count >= p_max THEN
    RETURN QUERY SELECT FALSE, v_row.count, v_row.window_start;
    RETURN;
  END IF;

  UPDATE public.edge_rate_limit
     SET count      = count + 1,
         updated_at = v_now
   WHERE key = p_key;

  RETURN QUERY SELECT TRUE, v_row.count + 1, v_row.window_start;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.check_and_bump_rate_limit(text, integer, integer)
  FROM anon, authenticated, public;
