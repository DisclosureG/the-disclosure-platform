-- Searchable surface for the Evidence page.
--
-- The Evidence search input used to call textSearch('fts', q), which
-- requires exact stemmed-token matches and silently drops partial words
-- (e.g. "psych" misses "psychedelics") and any tag tokens that don't
-- also appear in the visible text.  This migration adds a single
-- generated text column that concatenates every searchable field —
-- including array_to_string(tags) — and indexes it with a GIN trigram
-- index so ILIKE '%foo%' scans stay fast as the archive grows.

create extension if not exists pg_trgm with schema extensions;

-- Wrapped in an IMMUTABLE function so the call site is a single immutable
-- expression (generated-column requirement).  array_to_string is declared
-- STABLE upstream, but for a fixed input the result is deterministic.
create or replace function public._evidence_search_text(
  p_title   text,
  p_source  text,
  p_excerpt text,
  p_body    text,
  p_quote   text,
  p_tags    text[]
) returns text
language sql
immutable
as $$
  select coalesce(p_title,   '') || ' ' ||
         coalesce(p_source,  '') || ' ' ||
         coalesce(p_excerpt, '') || ' ' ||
         coalesce(p_body,    '') || ' ' ||
         coalesce(p_quote,   '') || ' ' ||
         coalesce(array_to_string(p_tags, ' '), '');
$$;

alter table public.evidence
  add column if not exists search_text text
  generated always as (
    public._evidence_search_text(title, source, excerpt, body, quote, tags)
  ) stored;

create index if not exists evidence_search_text_trgm_idx
  on public.evidence
  using gin (search_text extensions.gin_trgm_ops);
