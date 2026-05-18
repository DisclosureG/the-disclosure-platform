-- Off-chain mirror of BehaviourConsensus._resolveChallenge and lapse rules.
-- Clone of finalize_stale_evidence (20260514001100) retargeted at public.behaviour
-- and public.behaviour_attestations. Silence reaffirms (matches the contract).

CREATE OR REPLACE FUNCTION public.finalize_stale_behaviour()
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
  UPDATE behaviour
  SET    status = 'lapsed'
  WHERE  status = 'pending'
    AND  submitted_at < NOW() - INTERVAL '30 days';

  -- 2. Resolve expired challenges
  FOR rec IN
    SELECT id, challenge_reason, challenge_threshold
    FROM   behaviour
    WHERE  status = 'contested'
      AND  challenged_at < NOW() - INTERVAL '21 days'
  LOOP
    SELECT
      COUNT(*) FILTER (WHERE verdict = 'challenge'),
      COUNT(*) FILTER (WHERE verdict = 'defend')
    INTO ch_votes, df_votes
    FROM behaviour_attestations
    WHERE behaviour_id = rec.id
      AND phase = 'challenge';

    IF rec.challenge_threshold IS NOT NULL
       AND ch_votes >= rec.challenge_threshold
    THEN
      UPDATE behaviour
      SET    status            = 'deprecated',
             deprecated_at     = NOW(),
             deprecated_reason = rec.challenge_reason
      WHERE  id = rec.id;
    ELSE
      -- Window expired without deprecation quorum → reaffirm. Silence
      -- counts as a defense. Matches BehaviourConsensus._resolveChallenge.
      UPDATE behaviour
      SET    status = 'reaffirmed'
      WHERE  id = rec.id;
    END IF;
  END LOOP;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.finalize_stale_behaviour() FROM anon, authenticated, public;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'finalize-stale-behaviour-hourly') THEN
    PERFORM cron.schedule(
      'finalize-stale-behaviour-hourly',
      '0 * * * *',
      $$SELECT public.finalize_stale_behaviour();$$
    );
  END IF;
END $$;
