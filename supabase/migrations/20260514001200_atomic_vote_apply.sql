-- Transactional vote application.  Replaces the "select all attestations,
-- recompute, then update evidence" pattern in verify-attestation with a
-- single-statement, row-locked operation so two concurrent voters cannot
-- desync the count.
--
-- Caller (the edge function, running with service role) passes the recomputed
-- counts.  The row is locked FOR UPDATE inside the function so the status
-- transition is atomic with respect to other apply_* calls on the same row.

CREATE OR REPLACE FUNCTION public.apply_review_counts(
  p_evidence_id   uuid,
  p_approvals     integer,
  p_rejections    integer,
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
  SELECT id, status, tier
    INTO v_row
    FROM public.evidence
   WHERE id = p_evidence_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence not found';
  END IF;

  IF v_row.status = 'pending' THEN
    IF p_approvals >= p_canon_thresh THEN
      UPDATE public.evidence
         SET status        = 'canon',
             canon_at      = NOW(),
             reviewed_at   = NOW(),
             approve_count = p_approvals,
             reject_count  = p_rejections
       WHERE id = p_evidence_id;
    ELSIF p_rejections >= p_expel_thresh THEN
      UPDATE public.evidence
         SET status        = 'expelled',
             reviewed_at   = NOW(),
             approve_count = p_approvals,
             reject_count  = p_rejections
       WHERE id = p_evidence_id;
    ELSE
      UPDATE public.evidence
         SET approve_count = p_approvals,
             reject_count  = p_rejections
       WHERE id = p_evidence_id;
    END IF;
  ELSE
    -- Counts can still drift on votes recorded after canon/expel resolution
    -- (e.g. a late-arriving attestation). Keep them in sync without changing
    -- status.
    UPDATE public.evidence
       SET approve_count = p_approvals,
           reject_count  = p_rejections
     WHERE id = p_evidence_id;
  END IF;

  RETURN QUERY
    SELECT e.status, e.approve_count, e.reject_count
      FROM public.evidence e
     WHERE e.id = p_evidence_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_challenge_counts(
  p_evidence_id      uuid,
  p_challenge_votes  integer,
  p_defense_votes    integer,
  p_deprec_thresh    integer
)
RETURNS TABLE (status text, challenge_votes integer, defense_votes integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row RECORD;
BEGIN
  SELECT id, status, tier, challenge_reason
    INTO v_row
    FROM public.evidence
   WHERE id = p_evidence_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence not found';
  END IF;

  IF v_row.status = 'contested' AND p_challenge_votes >= p_deprec_thresh THEN
    UPDATE public.evidence
       SET status            = 'deprecated',
           deprecated_at     = NOW(),
           deprecated_reason = v_row.challenge_reason,
           challenge_votes   = p_challenge_votes,
           defense_votes     = p_defense_votes
     WHERE id = p_evidence_id;
  ELSE
    UPDATE public.evidence
       SET challenge_votes = p_challenge_votes,
           defense_votes   = p_defense_votes
     WHERE id = p_evidence_id;
  END IF;

  RETURN QUERY
    SELECT e.status, e.challenge_votes, e.defense_votes
      FROM public.evidence e
     WHERE e.id = p_evidence_id;
END;
$function$;

-- Only service-role can call these.  Defense in depth — the edge function is
-- the intended caller and runs with service role; PostgREST anon must not be
-- able to drive a status change.
REVOKE EXECUTE ON FUNCTION public.apply_review_counts(uuid,integer,integer,integer,integer)
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.apply_challenge_counts(uuid,integer,integer,integer)
  FROM anon, authenticated, public;
