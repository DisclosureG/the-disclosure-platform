-- ════════════════════════════════════════════════════════════════════════════
-- Consolidated schema — The Disclosure Platform / Evidence archive.
--
-- Single, self-consistent bootstrap for a FRESH Supabase project. Replaces the
-- historical incremental migration chain, which could not replay on an empty
-- database (early patches referenced dashboard-only objects, e.g. a REVOKE on a
-- function created in a later migration). This file builds the final schema
-- directly, in dependency order, with ZERO seed data: 0 evidence, 0 pillars,
-- 0 topics. Peers create the taxonomy and file evidence at runtime.
--
-- Companion on-chain contract: EvidenceConsensus (peers, taxonomy, evidence
-- lifecycle). Off-chain tables here are projections of, and inputs to, that
-- contract, reconciled by the chain-indexer-evidence edge function.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Extensions ───────────────────────────────────────────────────────────────
create extension if not exists pg_trgm with schema extensions;  -- trigram search
create extension if not exists pg_cron;                          -- scheduled jobs
create extension if not exists pg_net;                           -- http from cron
-- supabase_vault (`vault` schema) is enabled by default on Supabase and stores
-- the project_url / service_role_key secrets the cron invokers read at runtime.

-- ── Immutable search-surface function (evidence.search_text depends on it) ───
create or replace function public._evidence_search_text(
  p_title text, p_source text, p_excerpt text, p_body text, p_quote text, p_tags text[]
) returns text language sql immutable as $$
  select coalesce(p_title,   '') || ' ' ||
         coalesce(p_source,  '') || ' ' ||
         coalesce(p_excerpt, '') || ' ' ||
         coalesce(p_body,    '') || ' ' ||
         coalesce(p_quote,   '') || ' ' ||
         coalesce(array_to_string(p_tags, ' '), '');
$$;

-- Immutable tsvector builder (evidence.fts depends on it). Wrapping to_tsvector
-- in an explicitly-immutable function is required for the stored generated
-- column: a bare to_tsvector('english', …) is treated as stable (the text→regconfig
-- cast is stable and is not const-folded), which Postgres rejects in a generated
-- column. Postgres trusts this function's IMMUTABLE label, so the column is accepted.
create or replace function public._evidence_fts(
  p_title text, p_source text, p_excerpt text, p_body text, p_quote text, p_tags text[]
) returns tsvector language sql immutable as $$
  select to_tsvector('english'::regconfig,
    coalesce(p_title,   '') || ' ' ||
    coalesce(p_source,  '') || ' ' ||
    coalesce(p_excerpt, '') || ' ' ||
    coalesce(p_body,    '') || ' ' ||
    coalesce(p_quote,   '') || ' ' ||
    coalesce(array_to_string(p_tags, ' '), ''));
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- TAXONOMY — pillars (wider) → topics (deeper)
-- ════════════════════════════════════════════════════════════════════════════
-- Governed on-chain (proposePillar/proposeTopic/endorseNode). These tables hold
-- the human-readable metadata the chain only commits to as a keccak meta_hash;
-- node_hash = keccak256(slug) is the join key the indexer flips proposed→ratified.

create table public.pillars (
  id          text primary key,                 -- slug
  node_hash   text unique not null,             -- keccak256(slug), 0x-prefixed
  title       text not null,
  tag         text,
  blurb       text,
  ord         integer not null default 0,
  status      text not null default 'proposed' check (status in ('proposed','ratified','lapsed','retired')),
  meta_hash   text,
  proposed_by text,
  propose_tx  text,
  created_at  timestamptz not null default now()
);

create table public.topics (
  id          text primary key,                 -- slug
  pillar_id   text not null references public.pillars(id) on delete cascade,
  node_hash   text unique not null,
  title       text not null,
  blurb       text,
  ord         integer not null default 0,
  status      text not null default 'proposed' check (status in ('proposed','ratified','lapsed','retired')),
  meta_hash   text,
  proposed_by text,
  propose_tx  text,
  created_at  timestamptz not null default now()
);

create index pillars_status_idx on public.pillars (status);
create index topics_pillar_idx  on public.topics (pillar_id);
create index topics_status_idx  on public.topics (status);

-- ════════════════════════════════════════════════════════════════════════════
-- EVIDENCE
-- ════════════════════════════════════════════════════════════════════════════
create table public.evidence (
  id                   uuid primary key default gen_random_uuid(),

  -- Classification
  pillar_id            text,                                 -- denormalised from topic
  topic_id             text references public.topics(id),    -- authoritative filing target
  type                 text,
  tier                 smallint not null default 2 check (tier in (1,2,3)),

  -- Human-facing content
  title                text not null,
  source               text,
  year                 text,
  excerpt              text,
  body                 text,
  quote                text,
  link                 text,
  tags                 text[] not null default '{}',

  -- Lifecycle (7-state; legacy approved/rejected aliases tolerated)
  status               text not null default 'pending'
                       check (status in ('pending','canon','approved','expelled','rejected',
                                         'lapsed','contested','deprecated','reaffirmed')),
  submitted_at         timestamptz not null default now(),
  reviewed_at          timestamptz,
  canon_at             timestamptz,
  challenged_at        timestamptz,
  deprecated_at        timestamptz,
  expires_at           timestamptz,

  -- Materialised vote counters (kept fresh by attestations_count_sync)
  approve_count        integer not null default 0,
  reject_count         integer not null default 0,
  challenge_votes      integer not null default 0,
  defense_votes        integer not null default 0,
  challenge_threshold  integer,
  challenge_reason     text,
  deprecated_reason    text,

  -- On-chain binding
  content_hash         text,
  submitted_onchain    boolean not null default false,
  submitted_onchain_at timestamptz,
  submission_tx_hash   text,

  -- Search surfaces
  search_text          text generated always as (
                         public._evidence_search_text(title, source, excerpt, body, quote, tags)
                       ) stored,
  fts                  tsvector generated always as (
                         public._evidence_fts(title, source, excerpt, body, quote, tags)
                       ) stored
);

create index evidence_status_idx        on public.evidence (status);
create index evidence_pillar_topic_idx  on public.evidence (pillar_id, topic_id);
create index evidence_content_hash_idx  on public.evidence (content_hash) where content_hash is not null;
create index evidence_pending_onchain_idx on public.evidence (submitted_at) where status = 'pending' and submitted_onchain = true;
create index evidence_search_text_trgm_idx on public.evidence using gin (search_text extensions.gin_trgm_ops);
create index evidence_fts_idx           on public.evidence using gin (fts);

-- ════════════════════════════════════════════════════════════════════════════
-- BINDINGS — the voting unit: one (evidence × pillar → topic) filing
-- ════════════════════════════════════════════════════════════════════════════
-- binding_hash = on-chain bindingId = keccak256(abi.encode(uuidToBytes32(id),
-- keccak256(slug))). Each binding has its own 7-state lifecycle and tallies; only
-- canon / reaffirmed bindings show in the public archive. Counts are kept fresh
-- by attestation_count_sync; status transitions land via the chain indexer and
-- the apply_*_counts fast path. The content (and content_hash) lives once on
-- `evidence` — cross-listing a record never rehashes it.
create table public.bindings (
  id                   uuid primary key default gen_random_uuid(),
  evidence_id          uuid not null references public.evidence(id) on delete cascade,
  pillar_id            text not null,
  topic_id             text not null references public.topics(id),
  binding_hash         text,                                  -- on-chain bindingId, 0x-prefixed

  -- 'queued' (chain enum value 8): parks when the active review set is full, then
  -- the consensus-keeper promotes it into 'pending' (highest queue_priority first,
  -- then oldest queued_at) once a review slot frees.
  status               text not null default 'pending'
                       check (status in ('pending','canon','approved','expelled','rejected',
                                         'lapsed','contested','deprecated','reaffirmed','queued')),
  submitted_at         timestamptz not null default now(),
  reviewed_at          timestamptz,
  canon_at             timestamptz,
  challenged_at        timestamptz,
  deprecated_at        timestamptz,
  expires_at           timestamptz,

  approve_count        integer not null default 0,
  reject_count         integer not null default 0,
  challenge_votes      integer not null default 0,
  defense_votes        integer not null default 0,
  challenge_threshold  integer,
  challenge_reason     text,
  deprecated_reason    text,

  submitted_onchain    boolean not null default false,
  submitted_onchain_at timestamptz,
  submission_tx_hash   text,

  -- Queue projection: public boost tally + when it parked, for keeper promotion.
  queued_at            timestamptz,
  queue_priority       integer not null default 0,

  created_at           timestamptz not null default now(),
  unique (evidence_id, topic_id)
);

create index bindings_status_idx          on public.bindings (status);
create index bindings_evidence_idx        on public.bindings (evidence_id);
create index bindings_pillar_topic_idx    on public.bindings (pillar_id, topic_id);
create index bindings_hash_idx            on public.bindings (binding_hash) where binding_hash is not null;
create index bindings_pending_onchain_idx on public.bindings (submitted_at) where status = 'pending' and submitted_onchain = true;
-- Keeper promotion + public archive order: highest boost first, then FIFO.
create index bindings_queue_order_idx     on public.bindings (queue_priority desc, queued_at asc) where status = 'queued';

-- ════════════════════════════════════════════════════════════════════════════
-- ATTESTATIONS — one peer vote per (binding × phase)
-- ════════════════════════════════════════════════════════════════════════════
create table public.attestations (
  id          uuid primary key default gen_random_uuid(),
  evidence_id uuid not null references public.evidence(id) on delete cascade,
  binding_id  uuid references public.bindings(id) on delete cascade,
  topic_id    text,
  peer_addr   text not null,
  peer_handle text,
  -- 'taxonomy' phase / 'endorse' verdict log a peer's on-chain endorseNode of a
  -- proposed pillar/topic (tied to the proposal's founding binding). The count
  -- trigger ignores this phase — the on-chain gate stays the sole consensus path.
  phase       text not null default 'review' check (phase in ('review','challenge','taxonomy')),
  verdict     text check (verdict in ('approve','reject','challenge','defend','endorse')),
  note        text,
  eip712_sig  text,
  tx_hash     text,
  -- Vote-signature reconstruction surface: review/challenge eip712_sig rows are
  -- the on-chain `Vote(bindingId,phase,support,round,noteHash)` signature, so the
  -- public proof modal needs `round` + `note_hash` (plus the binding's on-chain
  -- binding_hash, joined in the view) to recompute the digest and recover the
  -- signer client-side. Null for taxonomy (Attestation-typed) and tx-proof rows.
  round       integer,
  note_hash   text,
  -- Every vote must carry a verifiable proof of its peer. 'eip712' rows are
  -- signed in the voter's browser (verify-attestation recovers the signer);
  -- 'tx' rows are indexer gap-fills proven by the on-chain tx sender. The
  -- CHECK below makes a proof-less row impossible, so vote history can never
  -- show a peer that isn't cryptographically attributable.
  proof_type  text not null default 'eip712' check (proof_type in ('eip712','tx')),
  created_at  timestamptz not null default now(),
  unique (binding_id, peer_addr, phase),        -- upsert conflict target
  constraint attestations_proof_present check (
    (proof_type = 'eip712' and eip712_sig is not null)
    or (proof_type = 'tx' and tx_hash is not null)
  )
);

create index attestations_evidence_idx on public.attestations (evidence_id);
create index attestations_binding_idx  on public.attestations (binding_id);
create index attestations_count_idx    on public.attestations (binding_id, phase, verdict);

-- Peer-revocation positions. The contract only tracks DISCARD votes (voteRevoke,
-- ceil(n/2) to remove) — there is no on-chain "keep". A keep is therefore an
-- off-chain EIP-712-signed dissent (mirrors the taxonomy reject): public,
-- attributable, and used by the peer-review batch gate so the network has to
-- take a position (keep or discard) on every open revocation and move on.
-- `subject_addr` is the peer under revocation; `voter_addr` the signing peer;
-- `round` is the on-chain revokeRound at write time, so a re-motion resets
-- positions exactly like the contract's per-round revoke votes.
create table public.revocation_votes (
  id           uuid primary key default gen_random_uuid(),
  subject_addr text not null,
  voter_addr   text not null,
  round        integer not null,
  verdict      text not null check (verdict in ('keep','discard')),
  note         text,
  eip712_sig   text not null,
  created_at   timestamptz not null default now(),
  unique (subject_addr, voter_addr, round)
);
create index revocation_votes_subject_idx on public.revocation_votes (subject_addr, round);
create index revocation_votes_voter_idx   on public.revocation_votes (voter_addr);

-- ════════════════════════════════════════════════════════════════════════════
-- CHAIN MIRROR + OPS TABLES
-- ════════════════════════════════════════════════════════════════════════════
create table public.chain_events (
  id           bigserial primary key,
  block_number bigint  not null,
  block_hash   text    not null,
  tx_hash      text    not null,
  log_index    integer not null,
  event_name   text    not null,
  evidence_id  uuid,
  peer_addr    text,
  payload      jsonb   not null default '{}'::jsonb,
  occurred_at  timestamptz,
  inserted_at  timestamptz not null default now(),
  unique (tx_hash, log_index)
);
create index chain_events_event_idx    on public.chain_events (event_name, block_number desc);
create index chain_events_evidence_idx on public.chain_events (evidence_id);
create index chain_events_peer_idx     on public.chain_events (peer_addr);

create table public.chain_event_cursor (
  contract_addr text primary key,
  last_block    bigint not null default 0,
  updated_at    timestamptz not null default now()
);

create table public.edge_rate_limit (
  key          text primary key,
  window_start timestamptz not null default now(),
  count        integer     not null default 0,
  updated_at   timestamptz not null default now()
);

-- Covers both evidence content_hash drift and taxonomy-node meta/node hash drift
-- (audit-content-hash recomputes each and opens an alert on mismatch). Exactly
-- one subject is set per row; node_id has no FK because a slug can exist as both
-- a pillar and a topic, so (subject_kind, node_id) identifies the node.
create table public.tamper_alerts (
  id              bigserial primary key,
  evidence_id     uuid references public.evidence(id) on delete cascade,
  node_id         text,
  subject_kind    text not null default 'evidence'
                  check (subject_kind in ('evidence', 'pillar', 'topic')),
  hash_kind       text not null default 'content'
                  check (hash_kind in ('content', 'meta', 'node')),
  expected_hash   text not null,
  stored_hash     text not null,
  detected_at     timestamptz not null default now(),
  resolved_at     timestamptz,
  resolution_note text,
  constraint tamper_alerts_subject_chk check (
    (subject_kind = 'evidence' and evidence_id is not null and node_id is null)
    or (subject_kind in ('pillar', 'topic') and node_id is not null and evidence_id is null)
  )
);
create index tamper_alerts_open_idx on public.tamper_alerts (detected_at desc) where resolved_at is null;
create index tamper_alerts_node_open_idx
  on public.tamper_alerts (subject_kind, node_id, hash_kind)
  where resolved_at is null and node_id is not null;

create table public.edge_function_heartbeat (
  function_name text primary key,
  last_success  timestamptz not null default now(),
  last_attempt  timestamptz not null default now(),
  last_status   text,
  last_payload  jsonb
);

-- ════════════════════════════════════════════════════════════════════════════
-- ROW-LEVEL SECURITY
-- ════════════════════════════════════════════════════════════════════════════
alter table public.evidence                enable row level security;
alter table public.bindings                enable row level security;
alter table public.attestations            enable row level security;
alter table public.revocation_votes        enable row level security;
alter table public.pillars                 enable row level security;
alter table public.topics                  enable row level security;
alter table public.chain_events            enable row level security;
alter table public.chain_event_cursor      enable row level security;
alter table public.edge_rate_limit         enable row level security;  -- no policies: service-role only
alter table public.tamper_alerts           enable row level security;
alter table public.edge_function_heartbeat enable row level security;

-- Public read everywhere the UI needs it.
create policy evidence_read          on public.evidence                for select using (true);
create policy bindings_read          on public.bindings                for select using (true);
create policy attestations_read      on public.attestations            for select using (true);
create policy revocation_votes_read  on public.revocation_votes        for select using (true);
create policy pillars_read           on public.pillars                 for select using (true);
create policy topics_read            on public.topics                  for select using (true);
create policy chain_events_read      on public.chain_events            for select using (true);
create policy chain_event_cursor_read on public.chain_event_cursor     for select using (true);
create policy tamper_alerts_read     on public.tamper_alerts           for select using (true);
create policy heartbeat_read         on public.edge_function_heartbeat for select using (true);

-- Anon may insert only fresh, unbound rows; promotion happens service-side.
create policy evidence_insert on public.evidence for insert
  with check (
    status = 'pending'
    and submitted_onchain    = false
    and content_hash         is null
    and submitted_onchain_at is null
    and submission_tx_hash   is null
  );
-- Anon may file fresh, unbound bindings; promotion happens service-side.
create policy bindings_insert on public.bindings for insert
  with check (
    status = 'pending'
    and submitted_onchain    = false
    and submitted_onchain_at is null
    and submission_tx_hash   is null
  );
create policy pillars_insert on public.pillars for insert
  with check (status = 'proposed' and propose_tx is null);
create policy topics_insert  on public.topics  for insert
  with check (status = 'proposed' and propose_tx is null);

-- ════════════════════════════════════════════════════════════════════════════
-- VOTE COUNTERS — materialised on the attestation side
-- ════════════════════════════════════════════════════════════════════════════
-- Vote tallies are materialised on the BINDING the attestation targets.
create or replace function public.attestation_count_sync()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare v_bid uuid; v_phase text; v_new text; v_old text;
begin
  if tg_op = 'INSERT' then
    v_bid := new.binding_id; v_phase := new.phase; v_new := new.verdict;
    if v_bid is null then return new; end if;
    if v_phase = 'review' then
      if v_new = 'approve' then update bindings set approve_count = coalesce(approve_count,0)+1 where id = v_bid;
      elsif v_new = 'reject' then update bindings set reject_count = coalesce(reject_count,0)+1 where id = v_bid; end if;
    elsif v_phase = 'challenge' then
      if v_new = 'challenge' then update bindings set challenge_votes = coalesce(challenge_votes,0)+1 where id = v_bid;
      elsif v_new = 'defend' then update bindings set defense_votes = coalesce(defense_votes,0)+1 where id = v_bid; end if;
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    v_bid := new.binding_id; v_phase := new.phase; v_new := new.verdict; v_old := old.verdict;
    if v_bid is null then return new; end if;
    if v_new is distinct from v_old then
      if v_phase = 'review' then
        if v_old = 'approve' then update bindings set approve_count = greatest(0, coalesce(approve_count,0)-1) where id = v_bid; end if;
        if v_old = 'reject'  then update bindings set reject_count  = greatest(0, coalesce(reject_count,0)-1)  where id = v_bid; end if;
        if v_new = 'approve' then update bindings set approve_count = coalesce(approve_count,0)+1 where id = v_bid; end if;
        if v_new = 'reject'  then update bindings set reject_count  = coalesce(reject_count,0)+1  where id = v_bid; end if;
      elsif v_phase = 'challenge' then
        if v_old = 'challenge' then update bindings set challenge_votes = greatest(0, coalesce(challenge_votes,0)-1) where id = v_bid; end if;
        if v_old = 'defend'    then update bindings set defense_votes   = greatest(0, coalesce(defense_votes,0)-1)   where id = v_bid; end if;
        if v_new = 'challenge' then update bindings set challenge_votes = coalesce(challenge_votes,0)+1 where id = v_bid; end if;
        if v_new = 'defend'    then update bindings set defense_votes   = coalesce(defense_votes,0)+1   where id = v_bid; end if;
      end if;
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    v_bid := old.binding_id; v_phase := old.phase; v_old := old.verdict;
    if v_bid is null then return old; end if;
    if v_phase = 'review' then
      if v_old = 'approve' then update bindings set approve_count = greatest(0, coalesce(approve_count,0)-1) where id = v_bid; end if;
      if v_old = 'reject'  then update bindings set reject_count  = greatest(0, coalesce(reject_count,0)-1)  where id = v_bid; end if;
    elsif v_phase = 'challenge' then
      if v_old = 'challenge' then update bindings set challenge_votes = greatest(0, coalesce(challenge_votes,0)-1) where id = v_bid; end if;
      if v_old = 'defend'    then update bindings set defense_votes   = greatest(0, coalesce(defense_votes,0)-1)   where id = v_bid; end if;
    end if;
    return old;
  end if;
  return null;
end;
$fn$;
revoke execute on function public.attestation_count_sync() from anon, authenticated, public;

create trigger attestations_count_sync
  after insert or update or delete on public.attestations
  for each row execute function public.attestation_count_sync();

-- Atomic per-BINDING status transitions (service-role only; called by
-- verify-attestation). Status moves on the binding, not the evidence.
create or replace function public.apply_review_counts(
  p_binding_id uuid, p_canon_thresh integer, p_expel_thresh integer
) returns table (status text, approve_count integer, reject_count integer)
language plpgsql security definer set search_path to 'public' as $fn$
declare v_row record;
begin
  select id, status, approve_count, reject_count into v_row
    from public.bindings where id = p_binding_id for update;
  if not found then raise exception 'binding not found'; end if;
  if v_row.status = 'pending' then
    if v_row.approve_count >= p_canon_thresh then
      update public.bindings set status='canon', canon_at=now(), reviewed_at=now() where id = p_binding_id;
    elsif v_row.reject_count >= p_expel_thresh then
      update public.bindings set status='expelled', reviewed_at=now() where id = p_binding_id;
    end if;
  end if;
  return query select b.status, b.approve_count, b.reject_count from public.bindings b where b.id = p_binding_id;
end;
$fn$;

create or replace function public.apply_challenge_counts(
  p_binding_id uuid, p_deprec_thresh integer
) returns table (status text, challenge_votes integer, defense_votes integer)
language plpgsql security definer set search_path to 'public' as $fn$
declare v_row record;
begin
  select id, status, challenge_reason, challenge_votes, defense_votes into v_row
    from public.bindings where id = p_binding_id for update;
  if not found then raise exception 'binding not found'; end if;
  if v_row.status = 'contested' and v_row.challenge_votes >= p_deprec_thresh then
    update public.bindings
       set status='deprecated', deprecated_at=now(), deprecated_reason=v_row.challenge_reason
     where id = p_binding_id;
  end if;
  return query select b.status, b.challenge_votes, b.defense_votes from public.bindings b where b.id = p_binding_id;
end;
$fn$;
revoke execute on function public.apply_review_counts(uuid,integer,integer)   from anon, authenticated, public;
revoke execute on function public.apply_challenge_counts(uuid,integer)        from anon, authenticated, public;

-- ════════════════════════════════════════════════════════════════════════════
-- RATE LIMITING + INSERT THROTTLES
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.check_and_bump_rate_limit(
  p_key text, p_window_s integer, p_max integer
) returns table (allowed boolean, current_count integer, window_start timestamptz)
language plpgsql security definer set search_path to 'public' as $fn$
declare v_now timestamptz := now(); v_count integer; v_win timestamptz;
begin
  insert into public.edge_rate_limit (key, window_start, count, updated_at)
       values (p_key, v_now, 1, v_now)
  on conflict (key) do nothing;
  if found then
    allowed := true; current_count := 1; window_start := v_now; return next; return;
  end if;

  update public.edge_rate_limit r
     set window_start = case when extract(epoch from (v_now - r.window_start)) > p_window_s then v_now else r.window_start end,
         count        = case when extract(epoch from (v_now - r.window_start)) > p_window_s then 1 else r.count + 1 end,
         updated_at   = v_now
   where r.key = p_key
     and (extract(epoch from (v_now - r.window_start)) > p_window_s or r.count < p_max)
   returning r.count, r.window_start into v_count, v_win;
  if found then
    allowed := true; current_count := v_count; window_start := v_win; return next; return;
  end if;

  select r.count, r.window_start into v_count, v_win from public.edge_rate_limit r where r.key = p_key;
  allowed := false; current_count := v_count; window_start := v_win; return next;
end;
$fn$;
revoke execute on function public.check_and_bump_rate_limit(text,integer,integer) from anon, authenticated, public;

-- 5 anon evidence inserts / IP / hour.
create or replace function public.evidence_throttle_anon_insert()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_role text := current_setting('request.jwt.claim.role', true);
  v_ip   text := coalesce(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for',
                          current_setting('request.headers', true)::jsonb ->> 'cf-connecting-ip', 'anon-no-ip');
  v_allowed boolean; v_count integer;
begin
  if v_role is distinct from 'anon' then return new; end if;
  v_ip := split_part(v_ip, ',', 1);
  select allowed, current_count into v_allowed, v_count
    from public.check_and_bump_rate_limit('ev_insert:' || v_ip, 3600, 5);
  if not v_allowed then raise exception 'Submission rate limit exceeded — try again later' using errcode = '54000'; end if;
  return new;
end;
$fn$;
revoke execute on function public.evidence_throttle_anon_insert() from anon, authenticated, public;
create trigger evidence_throttle_anon_insert
  before insert on public.evidence for each row
  execute function public.evidence_throttle_anon_insert();
-- Bindings share the evidence submission budget (ev_insert: prefix).
create trigger bindings_throttle_anon_insert
  before insert on public.bindings for each row
  execute function public.evidence_throttle_anon_insert();

-- 5 anon taxonomy-proposal inserts / IP / hour (pillars + topics).
create or replace function public.taxonomy_throttle_anon_insert()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
declare
  v_role text := current_setting('request.jwt.claim.role', true);
  v_ip   text := coalesce(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for',
                          current_setting('request.headers', true)::jsonb ->> 'cf-connecting-ip', 'anon-no-ip');
  v_allowed boolean; v_count integer;
begin
  if v_role is distinct from 'anon' then return new; end if;
  v_ip := split_part(v_ip, ',', 1);
  select allowed, current_count into v_allowed, v_count
    from public.check_and_bump_rate_limit('tax_insert:' || v_ip, 3600, 5);
  if not v_allowed then raise exception 'Proposal rate limit exceeded — try again later' using errcode = '54000'; end if;
  return new;
end;
$fn$;
revoke execute on function public.taxonomy_throttle_anon_insert() from anon, authenticated, public;
create trigger pillars_throttle_anon_insert
  before insert on public.pillars for each row execute function public.taxonomy_throttle_anon_insert();
create trigger topics_throttle_anon_insert
  before insert on public.topics for each row execute function public.taxonomy_throttle_anon_insert();

-- ════════════════════════════════════════════════════════════════════════════
-- VIEWS
-- ════════════════════════════════════════════════════════════════════════════
-- Attestation log flattens the peer vote with its binding's pillar/topic and the
-- parent evidence's title + searchable surface. binding_id may be null for very
-- old rows, so the binding/pillar/topic joins are left joins.
create view public.attestation_log_view with (security_invoker = true) as
  select a.id, a.evidence_id, a.binding_id, a.peer_addr, a.peer_handle, a.phase, a.verdict, a.note,
         a.created_at, a.eip712_sig, a.tx_hash,
         e.title as evidence_title, e.search_text as evidence_search_text,
         a.evidence_id::text as evidence_id_text,
         b.pillar_id, b.topic_id, t.title as topic_title,
         -- Evidence content surface: lets the proof modal recompute
         -- content_hash = keccak256({title,source,year,excerpt,link,tier})
         -- client-side and prove the displayed source link is the one bound to
         -- this evidence's on-chain commitment. submission_tx_hash is where that
         -- commitment was registered.
         e.source as evidence_source, e.year as evidence_year,
         e.excerpt as evidence_excerpt, e.link as evidence_link,
         e.tier as evidence_tier, e.content_hash, e.submission_tx_hash,
         -- proof_type + the Vote-reconstruction surface appended last so the live
         -- DB's `create or replace view` (append-only) matches byte-for-byte.
         -- binding_hash is the on-chain bindingId the Vote signature commits to.
         a.proof_type, b.binding_hash, a.round, a.note_hash
    from public.attestations a
    join public.evidence e on e.id = a.evidence_id
    left join public.bindings b on b.id = a.binding_id
    left join public.topics  t on t.id = b.topic_id;
grant select on public.attestation_log_view to anon, authenticated;

-- Bindings whose off-chain timer expired but the chain hasn't emitted a terminal
-- event — drives the "needs on-chain finalize" prompt. Status transitions are
-- owned exclusively by the chain → indexer path.
create view public.evidence_awaiting_chain_finalize as
  select b.id as binding_id, b.evidence_id, e.title, e.tier, b.pillar_id, b.topic_id,
         b.status, b.submitted_at, b.challenged_at,
         case when b.status='pending' then 'markLapsed' when b.status='contested' then 'finalizeChallenge' end as chain_action_needed,
         case when b.status='pending' then b.submitted_at + interval '30 days'
              when b.status='contested' then b.challenged_at + interval '21 days' end as chain_action_due
    from public.bindings b
    join public.evidence e on e.id = b.evidence_id
   where (b.status='pending'   and b.submitted_at  < now() - interval '30 days')
      or (b.status='contested' and b.challenged_at < now() - interval '21 days');
grant select on public.evidence_awaiting_chain_finalize to anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- SCHEDULED JOBS (pg_cron + pg_net) — invokers read project_url / service_role_key
-- from vault at run time, so they no-op safely until those secrets are set:
--   select vault.create_secret('https://<ref>.supabase.co', 'project_url');
--   select vault.create_secret('<service-role-key>',        'service_role_key');
-- ════════════════════════════════════════════════════════════════════════════

-- Heartbeat-only: chain is the exclusive source of terminal transitions.
create or replace function public.finalize_stale_evidence()
returns void language plpgsql security definer set search_path to 'public' as $fn$
declare v_pending integer; v_contested integer;
begin
  select count(*) into v_pending   from public.bindings where status='pending'   and submitted_at  < now() - interval '30 days';
  select count(*) into v_contested from public.bindings where status='contested' and challenged_at < now() - interval '21 days';
  raise notice 'finalize_stale_evidence: % pending past lapse window, % contested past challenge window — awaiting on-chain finalize', v_pending, v_contested;
end;
$fn$;
revoke execute on function public.finalize_stale_evidence() from anon, authenticated, public;

create or replace function public.invoke_chain_indexer_evidence()
returns bigint language plpgsql security definer set search_path to 'public', 'vault' as $fn$
declare v_url text; v_req bigint;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  if v_url is null then raise notice 'project_url secret missing; skipping chain-indexer invocation'; return null; end if;
  select net.http_post(
    url     := v_url || '/functions/v1/chain-indexer-evidence',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) into v_req;
  return v_req;
end;
$fn$;
revoke execute on function public.invoke_chain_indexer_evidence() from anon, authenticated, public;

create or replace function public.invoke_audit_content_hash()
returns bigint language plpgsql security definer set search_path to 'public', 'vault' as $fn$
declare v_url text; v_key text; v_req bigint;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then raise notice 'audit-content-hash secrets missing; skipping invocation'; return null; end if;
  select net.http_post(
    url     := v_url || '/functions/v1/audit-content-hash',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) into v_req;
  return v_req;
end;
$fn$;
revoke execute on function public.invoke_audit_content_hash() from anon, authenticated, public;

-- consensus-keeper: auto-prune inactive peers + priority-ordered queue promotion.
-- Authenticates with the service-role key (the keeper edge fn holds the signing
-- key for its on-chain prune/promote txs). Its on-chain powers are permissionless
-- and objectively gated, so this grants no authority beyond any address.
create or replace function public.invoke_consensus_keeper()
returns bigint language plpgsql security definer set search_path to 'public', 'vault' as $fn$
declare v_url text; v_key text; v_req bigint;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'service_role_key';
  if v_url is null or v_key is null then
    raise notice 'consensus-keeper secrets missing; skipping invocation'; return null;
  end if;
  select net.http_post(
    url     := v_url || '/functions/v1/consensus-keeper',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  ) into v_req;
  return v_req;
end;
$fn$;
revoke execute on function public.invoke_consensus_keeper() from anon, authenticated, public;

do $cron$
begin
  if not exists (select 1 from cron.job where jobname = 'chain-indexer-evidence-every-minute') then
    perform cron.schedule('chain-indexer-evidence-every-minute', '* * * * *',
      'select public.invoke_chain_indexer_evidence();');
  end if;
  if not exists (select 1 from cron.job where jobname = 'finalize-stale-evidence-hourly') then
    perform cron.schedule('finalize-stale-evidence-hourly', '0 * * * *',
      'select public.finalize_stale_evidence();');
  end if;
  if not exists (select 1 from cron.job where jobname = 'audit-content-hash-daily') then
    perform cron.schedule('audit-content-hash-daily', '17 3 * * *',
      'select public.invoke_audit_content_hash();');
  end if;
  if not exists (select 1 from cron.job where jobname = 'consensus-keeper-every-5-min') then
    perform cron.schedule('consensus-keeper-every-5-min', '*/5 * * * *',
      'select public.invoke_consensus_keeper();');
  end if;
end
$cron$;
