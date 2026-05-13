-- Match the updated contract: a contested piece that reaches window-expiry
-- without deprecation quorum is REAFFIRMED, regardless of whether any defense
-- votes were cast.  Previously the function left the row stuck on "contested"
-- when defense_votes <= challenge_votes — mirroring the original Solidity bug
-- that has now been fixed in EvidenceConsensus.sol::_resolveChallenge.

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
    ELSE
      -- Challenge did not reach threshold by window-close → reaffirm.
      -- Silence counts as a defense.
      UPDATE evidence
      SET    status = 'reaffirmed'
      WHERE  id = rec.id;
    END IF;
  END LOOP;
END;
$function$;
