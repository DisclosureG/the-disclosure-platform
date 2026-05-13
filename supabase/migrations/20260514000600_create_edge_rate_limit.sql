-- Lightweight per-key sliding-window counter used by the verify-attestation
-- edge function to throttle abuse. Keys can be peer_addr, client IP, or any
-- string the function chooses.

CREATE TABLE IF NOT EXISTS public.edge_rate_limit (
  key          text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  count        integer     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.edge_rate_limit ENABLE ROW LEVEL SECURITY;
-- No policies: service role bypasses RLS; PostgREST gets nothing.
