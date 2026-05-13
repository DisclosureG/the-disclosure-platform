-- Bind every on-chain submission to an immutable content hash.  The chain
-- record holds the same hash; if the off-chain row is ever mutated, the hashes
-- diverge and the chain proves the original payload.

ALTER TABLE public.evidence
  ADD COLUMN IF NOT EXISTS content_hash text;

-- Backfill: for existing rows we accept NULL.  New submissions will populate.
CREATE INDEX IF NOT EXISTS evidence_content_hash_idx
  ON public.evidence (content_hash)
  WHERE content_hash IS NOT NULL;
