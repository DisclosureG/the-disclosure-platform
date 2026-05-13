-- Bring finalize_stale_evidence() in line with EvidenceConsensus.sol::_resolveChallenge:
--   - Lapse pending past 30 days (unchanged).
--   - For contested past 21 days: deprecate iff challenge_votes >= threshold,
--     reaffirm iff defense_votes > challenge_votes, otherwise leave contested
--     (no automatic reaffirm on 0-vote silence).

CREATE OR REPLACE FUNCTION public.finalize_stale_evidence()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  rec      RECORD;
  ch_votes integer;
  df_votes integer;
BEGIN
  -- 1. Lapse pending items past the 30-day window
  UPDATE evidence
  SET    status = 'lapsed'
  WHERE  status = 'pending'
    AND  submitted_at < NOW() - INTERVAL '30 days';

  -- 2. Resolve expired challenges
  FOR rec IN
    SELECT id, challenge_reason, challenge_threshold
    FROM   evidence
    WHERE  status = 'contested'
      AND  challenged_at < NOW() - INTERVAL '21 days'
  LOOP
    SELECT
      COUNT(*) FILTER (WHERE verdict = 'challenge'),
      COUNT(*) FILTER (WHERE verdict = 'defend')
    INTO ch_votes, df_votes
    FROM attestations
    WHERE evidence_id = rec.id
      AND phase = 'challenge';

    IF rec.challenge_threshold IS NOT NULL
       AND ch_votes >= rec.challenge_threshold
    THEN
      UPDATE evidence
      SET    status            = 'deprecated',
             deprecated_at     = NOW(),
             deprecated_reason = rec.challenge_reason
      WHERE  id = rec.id;
    ELSIF df_votes > ch_votes THEN
      UPDATE evidence
      SET    status = 'reaffirmed'
      WHERE  id = rec.id;
    -- else: leave contested. Matches Solidity behaviour where a silent
    -- window expiry without defense majority does not auto-reaffirm.
    END IF;
  END LOOP;
END;
$function$;
