-- Behaviour attestations: per-peer signed votes on behaviour records.
-- Parallel to public.attestations but keyed at the behaviour table. Kept
-- separate so each archive has independent vote-history queries and so the
-- existing RLS policies, triggers, and counters on attestations remain
-- unchanged.

CREATE TABLE IF NOT EXISTS public.behaviour_attestations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  behaviour_id  uuid NOT NULL REFERENCES public.behaviour(id) ON DELETE CASCADE,
  peer_addr     text NOT NULL,
  peer_handle   text,
  phase         text NOT NULL DEFAULT 'review'
                CHECK (phase IN ('review','challenge')),
  verdict       text NOT NULL
                CHECK (verdict IN ('approve','reject','challenge','defend')),
  note          text,
  eip712_sig    text,
  tx_hash       text,
  created_at    timestamptz NOT NULL DEFAULT NOW(),

  -- One signed verdict per (record, peer, phase). Matches the contract's
  -- hasVoted[id][phase][voter] invariant.
  UNIQUE (behaviour_id, peer_addr, phase)
);

CREATE INDEX IF NOT EXISTS behaviour_attestations_behaviour_idx
  ON public.behaviour_attestations (behaviour_id);
CREATE INDEX IF NOT EXISTS behaviour_attestations_peer_idx
  ON public.behaviour_attestations (peer_addr);
CREATE INDEX IF NOT EXISTS behaviour_attestations_created_idx
  ON public.behaviour_attestations (created_at DESC);

ALTER TABLE public.behaviour_attestations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS behaviour_attestations_read ON public.behaviour_attestations;
CREATE POLICY behaviour_attestations_read
  ON public.behaviour_attestations FOR SELECT
  USING (true);
-- Writes: service-role only (via verify-attestation-behaviour edge function).
