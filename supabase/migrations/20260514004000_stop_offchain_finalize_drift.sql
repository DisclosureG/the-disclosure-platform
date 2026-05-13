-- Stop the off-chain auto-resolve path that created permanent divergence
-- from the chain.
--
-- Previous behaviour (20260514000300, 20260514001100): the hourly pg_cron
-- ran finalize_stale_evidence() which forcibly transitioned every
-- status='pending' past 30 days to 'lapsed', and every status='contested'
-- past 21 days to 'reaffirmed' or 'deprecated' based on off-chain
-- attestation counts.
--
-- The chain only transitions when someone calls markLapsed() /
-- finalizeChallenge() on-chain. If no peer pays the gas to do so, the
-- chain stays in Submitted / Contested forever while Supabase shows a
-- terminal state. The indexer's reconciliation guards (.in(status,[..]))
-- never fire because the off-chain row is no longer in the source state
-- the guard expects — so the cache lie is permanent.
--
-- After this migration the function is a heartbeat-only no-op. Status
-- transitions are owned exclusively by the chain → indexer path. A view
-- (evidence_awaiting_chain_finalize) lets the UI surface rows where the
-- off-chain timer has expired but the chain hasn't acted, so a peer can
-- be prompted to call the chain function.

CREATE OR REPLACE FUNCTION public.finalize_stale_evidence()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pending   integer;
  v_contested integer;
BEGIN
  -- Heartbeat only.  Count how many rows are awaiting on-chain action so
  -- operators can spot a backlog from the cron logs without the function
  -- ever mutating evidence state.  The chain + indexer remain the
  -- exclusive source of terminal state transitions.

  SELECT COUNT(*) INTO v_pending
    FROM public.evidence
   WHERE status = 'pending'
     AND submitted_at < NOW() - INTERVAL '30 days';

  SELECT COUNT(*) INTO v_contested
    FROM public.evidence
   WHERE status = 'contested'
     AND challenged_at < NOW() - INTERVAL '21 days';

  RAISE NOTICE 'finalize_stale_evidence: % pending past lapse window, % contested past challenge window — awaiting on-chain finalize',
    v_pending, v_contested;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.finalize_stale_evidence() FROM anon, authenticated, public;

-- UI-facing view: rows where the off-chain timer expired but the chain
-- hasn't emitted a terminal event yet.  PeerReview can drive a "needs
-- on-chain finalize" prompt from this so the chain catches up before the
-- divergence-of-perception bites.

CREATE OR REPLACE VIEW public.evidence_awaiting_chain_finalize AS
SELECT
  id,
  title,
  tier,
  pillar_id,
  status,
  submitted_at,
  challenged_at,
  CASE
    WHEN status = 'pending'   THEN 'markLapsed'
    WHEN status = 'contested' THEN 'finalizeChallenge'
  END AS chain_action_needed,
  CASE
    WHEN status = 'pending'   THEN submitted_at  + INTERVAL '30 days'
    WHEN status = 'contested' THEN challenged_at + INTERVAL '21 days'
  END AS chain_action_due
FROM public.evidence
WHERE (status = 'pending'   AND submitted_at  < NOW() - INTERVAL '30 days')
   OR (status = 'contested' AND challenged_at < NOW() - INTERVAL '21 days');

-- View follows the underlying RLS on evidence; no separate grant needed.
GRANT SELECT ON public.evidence_awaiting_chain_finalize TO anon, authenticated;
