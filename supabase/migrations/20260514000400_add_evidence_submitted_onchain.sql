-- On-chain submission gate: review queue only shows evidence that has been
-- registered on-chain via submitEvidenceOnChain().  Without this gate, peers
-- can sign DB attestations for evidence the contract has never seen, causing
-- their on-chain follow-up votes to revert ('unknown evidence').

ALTER TABLE public.evidence
  ADD COLUMN IF NOT EXISTS submitted_onchain    boolean   NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS submitted_onchain_at timestamptz,
  ADD COLUMN IF NOT EXISTS submission_tx_hash   text;

-- Existing canon / reaffirmed / contested / deprecated rows predate the gate;
-- mark them as onchain so the archive view remains intact.
UPDATE public.evidence
SET submitted_onchain = true
WHERE status IN ('canon','approved','reaffirmed','contested','deprecated','expelled','rejected','lapsed');

-- Helpful index for the queue filter.
CREATE INDEX IF NOT EXISTS evidence_pending_onchain_idx
  ON public.evidence (submitted_at)
  WHERE status = 'pending' AND submitted_onchain = true;
