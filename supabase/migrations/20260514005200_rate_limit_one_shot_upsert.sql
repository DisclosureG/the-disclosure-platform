-- One-shot atomic rate-limit RPC.
--
-- The v4 implementation (20260514004100) was correct for an EXISTING key
-- (SELECT FOR UPDATE serializes through the row lock).  For a brand-new
-- key it did SELECT FOR UPDATE → INSERT ON CONFLICT DO NOTHING → re-SELECT,
-- which races: two concurrent first-callers both observed NOT FOUND on
-- the initial SELECT, both INSERTed (one was DO NOTHING), both re-SELECTed
-- count=1, both returned allowed=TRUE.  The DB ended with count=1 even
-- though two requests had passed.
--
-- This rewrite splits into two ordered operations:
--   1.  INSERT ... ON CONFLICT DO NOTHING.  Brand-new key path; the
--       unique-constraint contention makes concurrent callers serialize
--       at the row level — only one INSERT actually returns FOUND=TRUE.
--   2.  UPDATE r SET ... WHERE key=p_key AND (windowstale OR count<max)
--       RETURNING (count, window_start).  Existing-key path; the
--       FOUND boolean tells us whether the over-cap reject branch hit.
--
-- Concurrent INSERT...ON CONFLICT DO NOTHING blocks on the unique
-- constraint until the first INSERT commits, so the second caller falls
-- through to the UPDATE step with the row already visible.  The UPDATE
-- then takes the row lock; PostgreSQL serializes multiple UPDATEs.  No
-- pre-state SELECT means no TOCTOU between read and write.
--
-- Signature, return shape, and grants are unchanged so the edge function
-- and the v5 evidence-throttle trigger keep calling it the same way.

DROP FUNCTION IF EXISTS public.check_and_bump_rate_limit(text, integer, integer);

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
  v_now    timestamptz := NOW();
  v_count  integer;
  v_win    timestamptz;
BEGIN
  -- 1. Brand-new key.  ON CONFLICT DO NOTHING blocks on the unique
  -- constraint when a concurrent INSERT is racing; whichever transaction
  -- commits first wins the FOUND=TRUE branch, the other falls through to
  -- the UPDATE.
  INSERT INTO public.edge_rate_limit (key, window_start, count, updated_at)
       VALUES (p_key, v_now, 1, v_now)
  ON CONFLICT (key) DO NOTHING;

  IF FOUND THEN
    allowed       := TRUE;
    current_count := 1;
    window_start  := v_now;
    RETURN NEXT;
    RETURN;
  END IF;

  -- 2. Existing key.  UPDATE acquires the row lock; the WHERE clause
  -- expresses the "allowed to bump" predicate (window stale OR under cap).
  -- A FOUND=TRUE means we bumped (or reset on a stale window); FOUND=FALSE
  -- means we hit the cap and the row was left untouched.
  UPDATE public.edge_rate_limit r
     SET window_start = CASE
                          WHEN EXTRACT(EPOCH FROM (v_now - r.window_start)) > p_window_s
                            THEN v_now
                          ELSE r.window_start
                        END,
         count        = CASE
                          WHEN EXTRACT(EPOCH FROM (v_now - r.window_start)) > p_window_s
                            THEN 1
                          ELSE r.count + 1
                        END,
         updated_at   = v_now
   WHERE r.key = p_key
     AND (EXTRACT(EPOCH FROM (v_now - r.window_start)) > p_window_s
          OR r.count < p_max)
   RETURNING r.count, r.window_start INTO v_count, v_win;

  IF FOUND THEN
    allowed       := TRUE;
    current_count := v_count;
    window_start  := v_win;
    RETURN NEXT;
    RETURN;
  END IF;

  -- 3. Over cap.  Return the current row state so the caller can render
  -- a meaningful 429.  The row is not modified.
  SELECT r.count, r.window_start
    INTO v_count, v_win
    FROM public.edge_rate_limit r
   WHERE r.key = p_key;

  allowed       := FALSE;
  current_count := v_count;
  window_start  := v_win;
  RETURN NEXT;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.check_and_bump_rate_limit(text, integer, integer)
  FROM anon, authenticated, public;
