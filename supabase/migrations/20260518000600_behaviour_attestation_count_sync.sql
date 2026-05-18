-- Materialise per-behaviour vote counts via a behaviour_attestations-side
-- trigger. Direct clone of attestation_count_sync (20260514003000) retargeted
-- at public.behaviour. Same invariants apply: rare UPDATEs, idempotent
-- backfill at end so the migration is safe on a running system.

CREATE OR REPLACE FUNCTION public.behaviour_attestation_count_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_bid   uuid;
  v_phase text;
  v_new   text;
  v_old   text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_bid   := NEW.behaviour_id;
    v_phase := NEW.phase;
    v_new   := NEW.verdict;
    IF v_phase = 'review' THEN
      IF v_new = 'approve' THEN
        UPDATE behaviour SET approve_count = COALESCE(approve_count, 0) + 1 WHERE id = v_bid;
      ELSIF v_new = 'reject' THEN
        UPDATE behaviour SET reject_count = COALESCE(reject_count, 0) + 1 WHERE id = v_bid;
      END IF;
    ELSIF v_phase = 'challenge' THEN
      IF v_new = 'challenge' THEN
        UPDATE behaviour SET challenge_votes = COALESCE(challenge_votes, 0) + 1 WHERE id = v_bid;
      ELSIF v_new = 'defend' THEN
        UPDATE behaviour SET defense_votes = COALESCE(defense_votes, 0) + 1 WHERE id = v_bid;
      END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    v_bid   := NEW.behaviour_id;
    v_phase := NEW.phase;
    v_new   := NEW.verdict;
    v_old   := OLD.verdict;
    IF v_new IS DISTINCT FROM v_old THEN
      IF v_phase = 'review' THEN
        IF v_old = 'approve' THEN UPDATE behaviour SET approve_count = GREATEST(0, COALESCE(approve_count, 0) - 1) WHERE id = v_bid; END IF;
        IF v_old = 'reject'  THEN UPDATE behaviour SET reject_count  = GREATEST(0, COALESCE(reject_count,  0) - 1) WHERE id = v_bid; END IF;
        IF v_new = 'approve' THEN UPDATE behaviour SET approve_count = COALESCE(approve_count, 0) + 1 WHERE id = v_bid; END IF;
        IF v_new = 'reject'  THEN UPDATE behaviour SET reject_count  = COALESCE(reject_count,  0) + 1 WHERE id = v_bid; END IF;
      ELSIF v_phase = 'challenge' THEN
        IF v_old = 'challenge' THEN UPDATE behaviour SET challenge_votes = GREATEST(0, COALESCE(challenge_votes, 0) - 1) WHERE id = v_bid; END IF;
        IF v_old = 'defend'    THEN UPDATE behaviour SET defense_votes   = GREATEST(0, COALESCE(defense_votes,   0) - 1) WHERE id = v_bid; END IF;
        IF v_new = 'challenge' THEN UPDATE behaviour SET challenge_votes = COALESCE(challenge_votes, 0) + 1 WHERE id = v_bid; END IF;
        IF v_new = 'defend'    THEN UPDATE behaviour SET defense_votes   = COALESCE(defense_votes,   0) + 1 WHERE id = v_bid; END IF;
      END IF;
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    v_bid   := OLD.behaviour_id;
    v_phase := OLD.phase;
    v_old   := OLD.verdict;
    IF v_phase = 'review' THEN
      IF v_old = 'approve' THEN UPDATE behaviour SET approve_count = GREATEST(0, COALESCE(approve_count, 0) - 1) WHERE id = v_bid; END IF;
      IF v_old = 'reject'  THEN UPDATE behaviour SET reject_count  = GREATEST(0, COALESCE(reject_count,  0) - 1) WHERE id = v_bid; END IF;
    ELSIF v_phase = 'challenge' THEN
      IF v_old = 'challenge' THEN UPDATE behaviour SET challenge_votes = GREATEST(0, COALESCE(challenge_votes, 0) - 1) WHERE id = v_bid; END IF;
      IF v_old = 'defend'    THEN UPDATE behaviour SET defense_votes   = GREATEST(0, COALESCE(defense_votes,   0) - 1) WHERE id = v_bid; END IF;
    END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.behaviour_attestation_count_sync() FROM anon, authenticated, public;

DROP TRIGGER IF EXISTS behaviour_attestations_count_sync ON public.behaviour_attestations;
CREATE TRIGGER behaviour_attestations_count_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.behaviour_attestations
  FOR EACH ROW
  EXECUTE FUNCTION public.behaviour_attestation_count_sync();

-- One-shot backfill: rebuild counters from the source of truth.
WITH r AS (
  SELECT
    behaviour_id,
    COUNT(*) FILTER (WHERE phase = 'review'    AND verdict = 'approve')   AS a,
    COUNT(*) FILTER (WHERE phase = 'review'    AND verdict = 'reject')    AS rj,
    COUNT(*) FILTER (WHERE phase = 'challenge' AND verdict = 'challenge') AS cv,
    COUNT(*) FILTER (WHERE phase = 'challenge' AND verdict = 'defend')    AS dv
  FROM public.behaviour_attestations
  GROUP BY behaviour_id
)
UPDATE public.behaviour b
   SET approve_count   = COALESCE(r.a,  0),
       reject_count    = COALESCE(r.rj, 0),
       challenge_votes = COALESCE(r.cv, 0),
       defense_votes   = COALESCE(r.dv, 0)
  FROM r
 WHERE b.id = r.behaviour_id;
