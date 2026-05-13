-- Drop the redundant UNIQUE constraint on attestations.
-- attestations_evidence_id_peer_addr_phase_key and
-- attestations_evidence_peer_phase_key have identical definitions.

ALTER TABLE public.attestations
  DROP CONSTRAINT IF EXISTS attestations_evidence_peer_phase_key;
