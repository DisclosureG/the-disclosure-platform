-- Materialise per-evidence vote counts via an attestation-side trigger so the
-- recount path is O(1) instead of "COUNT(*) FILTER over (evidence_id, phase)"
-- on every vote.  At 100 peers × 5000 evidence × 1 phase = 500k attestations
-- the COUNT becomes a noticeable share of the hot-path RPC cost; this trigger
-- keeps the numbers fresh as a side-effect of the upsert itself.
--
-- Correctness invariants:
--   * UPDATE on the attestations table is genuinely rare — peers cannot change
--     their verdict (the (evidence_id, peer_addr, phase) unique constraint
--     causes upserts of the same key to no-op; chain-level "already voted"
--     prevents double-voting in the first place). The trigger still handles
--     UPDATE for completeness so a service-role correction is consistent.
--   * The trigger uses the row's verdict at INSERT time; if a later UPDATE
--     flips the verdict we adjust by removing the old verdict's count and
--     adding the new one.
--   * `apply_review_counts` / `apply_challenge_counts` still hold
--     `FOR UPDATE` on the evidence row before reading the counters, so the
--     atomic recount-inside-lock semantic established in 20260514002000 is
--     preserved.
--   * One-shot backfill at the bottom rebuilds the columns from scratch so
--     the migration is safe to apply on a running system.

CREATE OR REPLACE FUNCTION public.attestation_count_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_eid uuid;
  v_phase text;
  v_new text;
  v_old text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_eid   := NEW.evidence_id;
    v_phase := NEW.phase;
    v_new   := NEW.verdict;
    IF v_phase = 'review' THEN
      IF v_new = 'approve' THEN
        UPDATE evidence SET approve_count = COALESCE(approve_count, 0) + 1 WHERE id = v_eid;
      ELSIF v_new = 'reject' THEN
        UPDATE evidence SET reject_count = COALESCE(reject_count, 0) + 1 WHERE id = v_eid;
      END IF;
    ELSIF v_phase = 'challenge' THEN
      IF v_new = 'challenge' THEN
        UPDATE evidence SET challenge_votes = COALESCE(challenge_votes, 0) + 1 WHERE id = v_eid;
      ELSIF v_new = 'defend' THEN
        UPDATE evidence SET defense_votes = COALESCE(defense_votes, 0) + 1 WHERE id = v_eid;
      END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Verdict flip (rare; only via service role).  Decrement old, increment new.
    v_eid   := NEW.evidence_id;
    v_phase := NEW.phase;
    v_new   := NEW.verdict;
    v_old   := OLD.verdict;
    IF v_new IS DISTINCT FROM v_old THEN
      IF v_phase = 'review' THEN
        IF v_old = 'approve' THEN UPDATE evidence SET approve_count = GREATEST(0, COALESCE(approve_count, 0) - 1) WHERE id = v_eid; END IF;
        IF v_old = 'reject'  THEN UPDATE evidence SET reject_count  = GREATEST(0, COALESCE(reject_count,  0) - 1) WHERE id = v_eid; END IF;
        IF v_new = 'approve' THEN UPDATE evidence SET approve_count = COALESCE(approve_count, 0) + 1 WHERE id = v_eid; END IF;
        IF v_new = 'reject'  THEN UPDATE evidence SET reject_count  = COALESCE(reject_count,  0) + 1 WHERE id = v_eid; END IF;
      ELSIF v_phase = 'challenge' THEN
        IF v_old = 'challenge' THEN UPDATE evidence SET challenge_votes = GREATEST(0, COALESCE(challenge_votes, 0) - 1) WHERE id = v_eid; END IF;
        IF v_old = 'defend'    THEN UPDATE evidence SET defense_votes   = GREATEST(0, COALESCE(defense_votes,   0) - 1) WHERE id = v_eid; END IF;
        IF v_new = 'challenge' THEN UPDATE evidence SET challenge_votes = COALESCE(challenge_votes, 0) + 1 WHERE id = v_eid; END IF;
        IF v_new = 'defend'    THEN UPDATE evidence SET defense_votes   = COALESCE(defense_votes,   0) + 1 WHERE id = v_eid; END IF;
      END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    v_eid   := OLD.evidence_id;
    v_phase := OLD.phase;
    v_old   := OLD.verdict;
    IF v_phase = 'review' THEN
      IF v_old = 'approve' THEN UPDATE evidence SET approve_count = GREATEST(0, COALESCE(approve_count, 0) - 1) WHERE id = v_eid; END IF;
      IF v_old = 'reject'  THEN UPDATE evidence SET reject_count  = GREATEST(0, COALESCE(reject_count,  0) - 1) WHERE id = v_eid; END IF;
    ELSIF v_phase = 'challenge' THEN
      IF v_old = 'challenge' THEN UPDATE evidence SET challenge_votes = GREATEST(0, COALESCE(challenge_votes, 0) - 1) WHERE id = v_eid; END IF;
      IF v_old = 'defend'    THEN UPDATE evidence SET defense_votes   = GREATEST(0, COALESCE(defense_votes,   0) - 1) WHERE id = v_eid; END IF;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.attestation_count_sync() FROM anon, authenticated, public;

DROP TRIGGER IF EXISTS attestations_count_sync ON public.attestations;
CREATE TRIGGER attestations_count_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.attestations
  FOR EACH ROW
  EXECUTE FUNCTION public.attestation_count_sync();

-- Idempotent backfill: rebuild the counter columns from the source of truth
-- so existing rows match the trigger's view going forward.  Runs once at
-- migration time; cheap even for hundreds of thousands of rows.
WITH r AS (
  SELECT
    evidence_id,
    COUNT(*) FILTER (WHERE phase = 'review' AND verdict = 'approve')   AS a,
    COUNT(*) FILTER (WHERE phase = 'review' AND verdict = 'reject')    AS rj,
    COUNT(*) FILTER (WHERE phase = 'challenge' AND verdict = 'challenge') AS cv,
    COUNT(*) FILTER (WHERE phase = 'challenge' AND verdict = 'defend')    AS dv
  FROM public.attestations
  GROUP BY evidence_id
)
UPDATE public.evidence e
   SET approve_count   = COALESCE(r.a, 0),
       reject_count    = COALESCE(r.rj, 0),
       challenge_votes = COALESCE(r.cv, 0),
       defense_votes   = COALESCE(r.dv, 0)
  FROM r
 WHERE e.id = r.evidence_id;

-- Replace the recount-inside-lock RPCs with ones that read the now-materialised
-- counts instead of re-running COUNT(*) FILTER.  The FOR UPDATE row lock on
-- the evidence row is preserved so the status transition is still atomic
-- with respect to concurrent vote-applies; the saving is the eliminated scan.

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
  v_row RECORD;
BEGIN
  -- Lock the evidence row first so concurrent apply_* calls serialise.
  -- The materialised counts on this row are produced by the
  -- attestations_count_sync trigger and are already up-to-date with every
  -- attestation that committed before our lock acquisition (trigger runs
  -- inside the originating transaction, so the count is visible to anyone
  -- who reads after that transaction commits).
  SELECT id, status, tier, approve_count, reject_count
    INTO v_row
    FROM public.evidence
   WHERE id = p_evidence_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence not found';
  END IF;

  IF v_row.status = 'pending' THEN
    IF v_row.approve_count >= p_canon_thresh THEN
      UPDATE public.evidence
         SET status        = 'canon',
             canon_at      = NOW(),
             reviewed_at   = NOW()
       WHERE id = p_evidence_id;
    ELSIF v_row.reject_count >= p_expel_thresh THEN
      UPDATE public.evidence
         SET status        = 'expelled',
             reviewed_at   = NOW()
       WHERE id = p_evidence_id;
    END IF;
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
  v_row RECORD;
BEGIN
  SELECT id, status, tier, challenge_reason, challenge_votes, defense_votes
    INTO v_row
    FROM public.evidence
   WHERE id = p_evidence_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'evidence not found';
  END IF;

  IF v_row.status = 'contested' AND v_row.challenge_votes >= p_deprec_thresh THEN
    UPDATE public.evidence
       SET status            = 'deprecated',
           deprecated_at     = NOW(),
           deprecated_reason = v_row.challenge_reason
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

-- The partial count index from 20260514002300 is no longer hot, but keep it
-- for the audit / chain-indexer paths which still benefit from index-only
-- scans when they re-derive counts. Dropping it would only save disk; it
-- stays earned-its-keep.
