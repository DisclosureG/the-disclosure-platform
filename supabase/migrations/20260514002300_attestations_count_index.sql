-- The existing UNIQUE(evidence_id, peer_addr, phase) index has peer_addr as
-- its second column, which prevents fast scans for
--   WHERE evidence_id = X AND phase = Y
-- that the recount path runs on every vote.  Add a tight (evidence_id, phase)
-- index with verdict INCLUDEd so apply_review_counts / apply_challenge_counts
-- can serve their COUNT(*) FILTER from an index-only scan as attestation
-- volume grows.

CREATE INDEX IF NOT EXISTS attestations_count_idx
  ON public.attestations (evidence_id, phase) INCLUDE (verdict);
