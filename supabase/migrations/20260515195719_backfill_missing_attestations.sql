-- Backfill attestations rows that exist on-chain (ReviewVoteCast /
-- ChallengeVoteCast events) but never landed in Supabase.
--
-- Cause: the off-chain attestation row is written by the verify-attestation
-- edge function, which the client calls *after* broadcasting its tx.  If the
-- client closes the tab / loses network / hits a 5xx between mining and the
-- edge-function call, the chain finalises the vote but Supabase never gets
-- the matching row.  Quorum is 1 today, so a single lost insert produces a
-- canon-status row with zero attestations — visibly: "Evidence 81 /
-- Attestations signed 73".
--
-- The chain-indexer change paired with this migration (idempotent upsert from
-- ReviewVoteCast / ChallengeVoteCast) prevents future drift; this migration
-- repairs the rows that drifted before that change shipped.
--
-- Idempotent: the (evidence_id, peer_addr, phase) unique constraint plus
-- NOT EXISTS predicate make this safe to re-run.  The attestation_count_sync
-- trigger will increment approve_count / reject_count / challenge_votes /
-- defense_votes on each insert; the affected rows currently sit at 0 for
-- those counters because nothing has touched them since the lost insert,
-- so the trigger restores the chain's view (every backfilled vote is one
-- approve / reject / challenge / defend, no more).
INSERT INTO public.attestations
       (evidence_id, peer_addr, peer_handle, phase, verdict, tx_hash, created_at)
SELECT ce.evidence_id,
       lower(ce.peer_addr),
       NULL,
       CASE ce.event_name
         WHEN 'ReviewVoteCast'    THEN 'review'
         WHEN 'ChallengeVoteCast' THEN 'challenge'
       END,
       CASE
         WHEN ce.event_name = 'ReviewVoteCast'    AND (ce.payload->>'approve')::boolean           THEN 'approve'
         WHEN ce.event_name = 'ReviewVoteCast'                                                    THEN 'reject'
         WHEN ce.event_name = 'ChallengeVoteCast' AND (ce.payload->>'support_challenge')::boolean THEN 'challenge'
         WHEN ce.event_name = 'ChallengeVoteCast'                                                 THEN 'defend'
       END,
       ce.tx_hash,
       ce.occurred_at
  FROM public.chain_events ce
 WHERE ce.event_name IN ('ReviewVoteCast', 'ChallengeVoteCast')
   AND NOT EXISTS (
         SELECT 1 FROM public.attestations a
          WHERE a.evidence_id = ce.evidence_id
            AND a.peer_addr   = lower(ce.peer_addr)
            AND a.phase       = CASE ce.event_name
                                  WHEN 'ReviewVoteCast'    THEN 'review'
                                  WHEN 'ChallengeVoteCast' THEN 'challenge'
                                END
       )
ON CONFLICT (evidence_id, peer_addr, phase) DO NOTHING;
