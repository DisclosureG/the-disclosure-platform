-- Behaviour-side chain event log. Identical shape to public.chain_events but
-- keyed at the behaviour table so the two indexers maintain independent
-- cursors and the two activity feeds can be queried without a discriminator.

CREATE TABLE IF NOT EXISTS public.behaviour_chain_events (
  id            bigserial PRIMARY KEY,
  block_number  bigint    NOT NULL,
  block_hash    text      NOT NULL,
  tx_hash       text      NOT NULL,
  log_index     integer   NOT NULL,
  event_name    text      NOT NULL,
  behaviour_id  uuid,
  peer_addr     text,
  payload       jsonb     NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz,
  inserted_at   timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS behaviour_chain_events_event_idx
  ON public.behaviour_chain_events (event_name, block_number DESC);
CREATE INDEX IF NOT EXISTS behaviour_chain_events_behaviour_idx
  ON public.behaviour_chain_events (behaviour_id);
CREATE INDEX IF NOT EXISTS behaviour_chain_events_peer_idx
  ON public.behaviour_chain_events (peer_addr);

-- Cursor: independent from the evidence indexer so a stall on one contract
-- does not block the other.
CREATE TABLE IF NOT EXISTS public.behaviour_chain_event_cursor (
  contract_addr text PRIMARY KEY,
  last_block    bigint NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE public.behaviour_chain_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.behaviour_chain_event_cursor ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS behaviour_chain_events_read       ON public.behaviour_chain_events;
DROP POLICY IF EXISTS behaviour_chain_event_cursor_read ON public.behaviour_chain_event_cursor;

CREATE POLICY behaviour_chain_events_read
  ON public.behaviour_chain_events FOR SELECT
  USING (true);

CREATE POLICY behaviour_chain_event_cursor_read
  ON public.behaviour_chain_event_cursor FOR SELECT
  USING (true);
