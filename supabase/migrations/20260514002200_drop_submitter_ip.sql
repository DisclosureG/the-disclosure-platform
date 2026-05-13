-- The `submitter_ip` column on evidence was added by 20260514001300 to support
-- IP-based throttling, but the column itself is never written by the trigger
-- and is reachable via the public-read RLS on `evidence`.  Dropping it removes
-- a future-leak vector.  The throttle continues to work because it stores
-- counts keyed by IP in `edge_rate_limit`, not on the evidence row.

ALTER TABLE public.evidence
  DROP COLUMN IF EXISTS submitter_ip;
