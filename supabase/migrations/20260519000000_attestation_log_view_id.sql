-- Extends attestation_log_view with a text-cast evidence_id column so the
-- peer-review attestation log search can match by UUID (full or prefix), not
-- just title/source/tags. PostgREST ilike requires a text column; uuid::text
-- preserves the canonical hyphenated form so an 8-char prefix copy from the
-- archive cards still matches.
--
-- Note: new columns are appended at the end — Postgres rejects CREATE OR
-- REPLACE VIEW when an existing column's position or name would change.

create or replace view public.attestation_log_view
with (security_invoker = true) as
select
  a.id,
  a.evidence_id,
  a.peer_addr,
  a.peer_handle,
  a.phase,
  a.verdict,
  a.note,
  a.created_at,
  a.eip712_sig,
  a.tx_hash,
  e.title       as evidence_title,
  e.search_text as evidence_search_text,
  a.evidence_id::text as evidence_id_text
from public.attestations a
join public.evidence e on e.id = a.evidence_id;

grant select on public.attestation_log_view to anon, authenticated;
