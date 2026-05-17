-- Searchable surface for the peer-review attestation log.
--
-- The log needs to filter rows where ANY of (peer_handle, peer_addr, the
-- joined evidence's full search_text) matches each search term.  PostgREST
-- doesn't support dotted references to embedded resources inside `or=(...)`,
-- so we expose a flattened view that inlines evidence.search_text as a plain
-- column on each row.  The client can then use a single per-term `or` filter
-- across three regular columns, mirroring the Evidence page's search UX.
--
-- security_invoker=true preserves the underlying RLS posture of attestations
-- and evidence — anon can already SELECT both tables, so the view inherits
-- that access without granting anything new.

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
  e.search_text as evidence_search_text
from public.attestations a
join public.evidence e on e.id = a.evidence_id;

grant select on public.attestation_log_view to anon, authenticated;
