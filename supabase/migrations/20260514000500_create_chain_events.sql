-- Chain events table: indexer mirrors EvidenceConsensus events here so the
-- UI has a real chain-side activity feed and so we can reconcile drift
-- between the contract and the Supabase cache.

CREATE TABLE IF NOT EXISTS public.chain_events (
  id            bigserial PRIMARY KEY,
  block_number  bigint    NOT NULL,
  block_hash    text      NOT NULL,
  tx_hash       text      NOT NULL,
  log_index     integer   NOT NULL,
  event_name    text      NOT NULL,
  -- Common projected fields. Null when not applicable to the event type.
  evidence_id   uuid,
  peer_addr     text,
  payload       jsonb     NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz,
  inserted_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS chain_events_event_idx        ON public.chain_events (event_name, block_number DESC);
CREATE INDEX IF NOT EXISTS chain_events_evidence_idx     ON public.chain_events (evidence_id);
CREATE INDEX IF NOT EXISTS chain_events_peer_idx         ON public.chain_events (peer_addr);

-- Cursor table so the indexer can pick up where it left off.
CREATE TABLE IF NOT EXISTS public.chain_event_cursor (
  contract_addr text PRIMARY KEY,
  last_block    bigint NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- RLS: public read, no public writes.
ALTER TABLE public.chain_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chain_event_cursor ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chain_events_read       ON public.chain_events;
DROP POLICY IF EXISTS chain_event_cursor_read ON public.chain_event_cursor;

CREATE POLICY chain_events_read
  ON public.chain_events FOR SELECT
  USING (true);

CREATE POLICY chain_event_cursor_read
  ON public.chain_event_cursor FOR SELECT
  USING (true);
