-- Atomic vote-apply RPCs for behaviour records. The shape parallels
-- apply_review_counts / apply_challenge_counts on the evidence side
-- (see 20260514003000_materialize_attestation_counts.sql) — read the
-- materialised counters with FOR UPDATE then flip status when threshold
-- is met. The trigger added in B7 keeps the counters fresh, so this is
-- O(1) regardless of attestation volume.

CREATE OR REPLACE FUNCTION public.apply_behaviour_review_counts(
  p_behaviour_id  uuid,
  p_canon_thresh  integer,
  p_expel_thresh  integer
)
RETURNS TABLE (status text, approve_count integer, reject_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row RECORD;
BEGIN
  SELECT id, status, tier, approve_count, reject_count
    INTO v_row
    FROM public.behaviour
   WHERE id = p_behaviour_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'behaviour not found';
  END IF;

  IF v_row.status = 'pending' THEN
    IF v_row.approve_count >= p_canon_thresh THEN
      UPDATE public.behaviour
         SET status      = 'aligned',
             canon_at    = NOW(),
             reviewed_at = NOW()
       WHERE id = p_behaviour_id;
    ELSIF v_row.reject_count >= p_expel_thresh THEN
      UPDATE public.behaviour
         SET status      = 'misaligned',
             reviewed_at = NOW()
       WHERE id = p_behaviour_id;
    END IF;
  END IF;

  RETURN QUERY
    SELECT b.status, b.approve_count, b.reject_count
      FROM public.behaviour b
     WHERE b.id = p_behaviour_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_behaviour_challenge_counts(
  p_behaviour_id   uuid,
  p_deprec_thresh  integer
)
RETURNS TABLE (status text, challenge_votes integer, defense_votes integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row RECORD;
BEGIN
  SELECT id, status, tier, challenge_reason, challenge_votes, defense_votes
    INTO v_row
    FROM public.behaviour
   WHERE id = p_behaviour_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'behaviour not found';
  END IF;

  IF v_row.status = 'contested' AND v_row.challenge_votes >= p_deprec_thresh THEN
    UPDATE public.behaviour
       SET status            = 'deprecated',
           deprecated_at     = NOW(),
           deprecated_reason = v_row.challenge_reason
     WHERE id = p_behaviour_id;
  END IF;

  RETURN QUERY
    SELECT b.status, b.challenge_votes, b.defense_votes
      FROM public.behaviour b
     WHERE b.id = p_behaviour_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.apply_behaviour_review_counts(uuid, integer, integer)
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.apply_behaviour_challenge_counts(uuid, integer)
  FROM anon, authenticated, public;
