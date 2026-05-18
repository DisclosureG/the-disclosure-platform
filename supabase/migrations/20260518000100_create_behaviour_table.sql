-- Behaviour records: AI-alignment companion archive to public.evidence.
--
-- Each row is a single (model, input, output) tuple — a specific AI behaviour
-- in a specific context — that peers can vote on as "aligned" or "misaligned"
-- under the same 7-state lifecycle used for evidence.
--
-- Schema is parallel to public.evidence so the shared peer registry, indexer
-- pattern, and audit pipeline can be reused with surgical changes.
--
-- Status strings differ from evidence intentionally:
--   pending → aligned | misaligned | lapsed | contested → deprecated | reaffirmed
-- This keeps a future union query trivial to filter by record type.

CREATE TABLE IF NOT EXISTS public.behaviour (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Subject classification
  domain                  smallint NOT NULL CHECK (domain BETWEEN 1 AND 9),
  tier                    smallint NOT NULL CHECK (tier IN (1, 2, 3)),

  -- Human-facing description
  title                   text     NOT NULL,
  summary                 text,

  -- Model identity
  model_name              text     NOT NULL,
  model_version           text,

  -- On-chain bindings (keccak256 fingerprints, kept as 0x-prefixed text)
  model_hash              text,
  input_hash              text,
  output_hash             text,

  -- Off-chain payload bundles (the readable content the hashes refer to)
  input_payload           jsonb,
  output_payload          jsonb,
  seed                    text,
  sampling_params         jsonb,

  -- Lifecycle
  status                  text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','aligned','misaligned','lapsed',
                                            'contested','deprecated','reaffirmed')),
  submitted_at            timestamptz NOT NULL DEFAULT NOW(),
  reviewed_at             timestamptz,
  canon_at                timestamptz,
  challenged_at           timestamptz,
  deprecated_at           timestamptz,

  -- Vote counters (materialised by trigger; B7)
  approve_count           integer NOT NULL DEFAULT 0,
  reject_count            integer NOT NULL DEFAULT 0,
  challenge_votes         integer NOT NULL DEFAULT 0,
  defense_votes           integer NOT NULL DEFAULT 0,
  challenge_threshold     integer,
  challenge_reason        text,
  deprecated_reason       text,

  -- Chain submission bookkeeping
  submitted_onchain       boolean NOT NULL DEFAULT FALSE,
  submitted_onchain_at    timestamptz,
  submission_tx_hash      text
);

CREATE INDEX IF NOT EXISTS behaviour_status_idx        ON public.behaviour (status);
CREATE INDEX IF NOT EXISTS behaviour_domain_idx        ON public.behaviour (domain);
CREATE INDEX IF NOT EXISTS behaviour_onchain_idx       ON public.behaviour (submitted_onchain);
CREATE INDEX IF NOT EXISTS behaviour_submitted_at_idx  ON public.behaviour (submitted_at DESC);

-- RLS: anon can SELECT and INSERT (insert is throttled by B8); only the
-- service role can update / delete. Mirrors evidence policy from prior
-- migrations.
ALTER TABLE public.behaviour ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS behaviour_read   ON public.behaviour;
DROP POLICY IF EXISTS behaviour_insert ON public.behaviour;

CREATE POLICY behaviour_read
  ON public.behaviour FOR SELECT
  USING (true);

CREATE POLICY behaviour_insert
  ON public.behaviour FOR INSERT
  WITH CHECK (
    -- anon may insert pending rows; submitted_onchain must remain false
    -- and on-chain fields must be NULL. Promotion happens server-side.
    (status = 'pending')
    AND submitted_onchain = FALSE
    AND model_hash  IS NULL
    AND input_hash  IS NULL
    AND output_hash IS NULL
    AND submitted_onchain_at IS NULL
    AND submission_tx_hash   IS NULL
  );
