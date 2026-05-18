-- Tamper alerts for behaviour records: the audit-behaviour-hash edge function
-- writes here when a recomputed triple hash diverges from the on-chain value
-- stored in BehaviourConsensus.records.

CREATE TABLE IF NOT EXISTS public.behaviour_tamper_alerts (
  id              bigserial PRIMARY KEY,
  behaviour_id    uuid       NOT NULL REFERENCES public.behaviour(id) ON DELETE CASCADE,
  expected_hash   text       NOT NULL,
  stored_hash     text       NOT NULL,
  detected_at     timestamptz NOT NULL DEFAULT NOW(),
  resolved_at     timestamptz,
  resolution_note text
);

CREATE INDEX IF NOT EXISTS behaviour_tamper_alerts_open_idx
  ON public.behaviour_tamper_alerts (detected_at DESC)
  WHERE resolved_at IS NULL;

-- At most one open alert per behaviour row at a time. Matches the audit
-- pattern: each daily run can create a new alert only once the previous
-- one has been resolved (by service-role human review).
CREATE UNIQUE INDEX IF NOT EXISTS behaviour_tamper_alerts_one_open
  ON public.behaviour_tamper_alerts (behaviour_id)
  WHERE resolved_at IS NULL;

ALTER TABLE public.behaviour_tamper_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS behaviour_tamper_alerts_read ON public.behaviour_tamper_alerts;
CREATE POLICY behaviour_tamper_alerts_read
  ON public.behaviour_tamper_alerts FOR SELECT
  USING (true);
-- Writes via service role only.
