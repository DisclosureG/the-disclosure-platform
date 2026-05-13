-- Documentation-only migration.  The fix for the re-contest cycle reset bug
-- (v5 §3.1) lives in the edge functions, not in SQL — there is no schema
-- change to apply.  This file exists so the deployment order in
-- SYSTEM_ASSESSMENT.md §6 maps 1:1 to migrations/, and so an operator who
-- inspects the v5 cutover can see the cycle-reset decision recorded in the
-- migrations log.
--
-- Symptom (pre-v5):  canon → contested → reaffirmed → contested left the
-- off-chain materialised challenge_votes / defense_votes carrying cycle-1's
-- totals into cycle 2.  The trigger only ever increments, so the first
-- cycle-2 challenge attestation could push the count above the deprecation
-- threshold off-chain on its first vote — silent divergence from the chain
-- where openChallenge() resets r.challengeVotes=1, r.defenseVotes=0.
--
-- Fix (v5):
--   * chain-indexer's ChallengeOpened reconciliation now writes
--     challenge_votes=1, defense_votes=0 alongside status='contested'.
--     This is a carve-out from the v4 "indexer never writes counts" rule
--     justified by the chain itself resetting those columns at
--     openChallenge time.  See supabase/functions/chain-indexer/index.ts.
--   * verify-attestation's open_challenge action does the same reset
--     whether the prior status was canon/approved/reaffirmed (UI raced
--     the indexer) or already contested (indexer ran first).  Symmetric
--     handling ensures both flows end with the opener's vote as the only
--     count regardless of which side observes the cycle restart first.
--
-- No SQL change required.

DO $$ BEGIN
  RAISE NOTICE 'v5 cycle-reset fix: change lives in chain-indexer and verify-attestation edge functions, not in SQL.';
END $$;
