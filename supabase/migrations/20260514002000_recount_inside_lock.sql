-- Recount-inside-lock for review + challenge votes.
--
-- Previously the edge function (verify-attestation) computed approve/reject
-- counts in JS *before* calling apply_review_counts, and only the UPDATE
-- inside the RPC was serialized by FOR UPDATE.  Two concurrent voters could
-- each compute a stale count, then race the RPC — the later UPDATE could
-- overwrite the fresher count with a stale value and a status flip could
-- fire on the wrong side.  The chain is still authoritative, but the cache
-- and any UI driven by it flicker through wrong states.
--
-- This migration moves the COUNT(*) inside the RPC, after the FOR UPDATE
-- lock on the evidence row, so the count is always fresh relative to any
-- concurrent vote that has committed to attestations.
--
-- Signature change: callers no longer pass the counts.  Edge function must
-- be redeployed in lockstep with this migration.

DROP FUNCTION IF EXISTS public.apply_review_counts(uuid, integer, integer, integer, integer);
DROP FUNCTION IF EXISTS public.apply_challenge_counts(uuid, integer, integer, integer);

CREATE OR REPLACE FUNCTION public.apply_review_counts(
  p_evidence_id   uuid,
  p_canon_thresh  integer,
  p_expel_thresh  integer
)
RETURNS TABLE (status text, approve_count integer, reject_count integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row        RECORD;
  v_approvals  integer;
  v_rejections integer;
BEGIN
  -- Lock the evidence row first; all subsequent reads & writes within this
  -- transaction observe a consistent snapshot relative to other vote-applies.
  SELECT id, status, tier
    INTO v_row
    FROM public.evidence
   WHERE id = p_evidence_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence not found';
  END IF;

  -- Recount from attestations *after* the lock, so we see every attestation
  -- that committed before our lock acquisition.
  SELECT
    COUNT(*) FILTER (WHERE a.verdict = 'approve'),
    COUNT(*) FILTER (WHERE a.verdict = 'reject')
    INTO v_approvals, v_rejections
    FROM public.attestations a
   WHERE a.evidence_id = p_evidence_id
     AND a.phase       = 'review';

  IF v_row.status = 'pending' THEN
    IF v_approvals >= p_canon_thresh THEN
      UPDATE public.evidence
         SET status        = 'canon',
             canon_at      = NOW(),
             reviewed_at   = NOW(),
             approve_count = v_approvals,
             reject_count  = v_rejections
       WHERE id = p_evidence_id;
    ELSIF v_rejections >= p_expel_thresh THEN
      UPDATE public.evidence
         SET status        = 'expelled',
             reviewed_at   = NOW(),
             approve_count = v_approvals,
             reject_count  = v_rejections
       WHERE id = p_evidence_id;
    ELSE
      UPDATE public.evidence
         SET approve_count = v_approvals,
             reject_count  = v_rejections
       WHERE id = p_evidence_id;
    END IF;
  ELSE
    -- Late-arriving attestation after resolution. Sync the counts but do
    -- not change status.
    UPDATE public.evidence
       SET approve_count = v_approvals,
           reject_count  = v_rejections
     WHERE id = p_evidence_id;
  END IF;

  RETURN QUERY
    SELECT e.status, e.approve_count, e.reject_count
      FROM public.evidence e
     WHERE e.id = p_evidence_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_challenge_counts(
  p_evidence_id   uuid,
  p_deprec_thresh integer
)
RETURNS TABLE (status text, challenge_votes integer, defense_votes integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row    RECORD;
  v_chvotes integer;
  v_dfvotes integer;
BEGIN
  SELECT id, status, tier, challenge_reason
    INTO v_row
    FROM public.evidence
   WHERE id = p_evidence_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence not found';
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE a.verdict = 'challenge'),
    COUNT(*) FILTER (WHERE a.verdict = 'defend')
    INTO v_chvotes, v_dfvotes
    FROM public.attestations a
   WHERE a.evidence_id = p_evidence_id
     AND a.phase       = 'challenge';

  IF v_row.status = 'contested' AND v_chvotes >= p_deprec_thresh THEN
    UPDATE public.evidence
       SET status            = 'deprecated',
           deprecated_at     = NOW(),
           deprecated_reason = v_row.challenge_reason,
           challenge_votes   = v_chvotes,
           defense_votes     = v_dfvotes
     WHERE id = p_evidence_id;
  ELSE
    UPDATE public.evidence
       SET challenge_votes = v_chvotes,
           defense_votes   = v_dfvotes
     WHERE id = p_evidence_id;
  END IF;

  RETURN QUERY
    SELECT e.status, e.challenge_votes, e.defense_votes
      FROM public.evidence e
     WHERE e.id = p_evidence_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.apply_review_counts(uuid, integer, integer)
  FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.apply_challenge_counts(uuid, integer)
  FROM anon, authenticated, public;
