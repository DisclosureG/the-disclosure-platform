import { useState, useEffect, useCallback } from 'react';
import { supabase } from './lib/supabase';

// ── Taxonomy: Pillar → Topic ──────────────────────────────────────────────────
//
// Pillars (wider) and topics (deeper) are governed on-chain and projected into
// the `pillars` / `topics` Supabase tables.  We cache the ratified set at module
// scope so every hook — and the synchronous normalize() below — shares one copy
// instead of refetching.  ensureTaxonomy() is idempotent; useTaxonomy() exposes
// the live, reshaped tree to React.

let _taxonomy = { pillars: [], topics: [], pillarMap: {}, topicMap: {}, proposedPillarMap: {}, proposedTopicMap: {}, loaded: false };
let _taxonomyPromise = null;

async function loadTaxonomy() {
  // Proposed (not-yet-ratified) nodes are loaded alongside the ratified set so
  // surfaces like the vote history can resolve a proposal's pillar/topic title
  // (and flag it as not-yet-existing) before it ratifies.
  const [{ data: pillars }, { data: topics }, { data: proposedPillars }, { data: proposedTopics }] = await Promise.all([
    supabase.from('pillars').select('*').eq('status', 'ratified').order('ord', { ascending: true }),
    supabase.from('topics').select('*').eq('status', 'ratified').order('ord', { ascending: true }),
    supabase.from('pillars').select('id, title').eq('status', 'proposed'),
    supabase.from('topics').select('id, title, pillar_id').eq('status', 'proposed'),
  ]);
  const pillarRows = pillars || [];
  const topicRows  = topics  || [];
  // Display number is positional (01, 02, …) so it stays stable as pillars grow.
  const shaped = pillarRows.map((p, i) => ({
    ...p,
    n: String(i + 1).padStart(2, '0'),
    topics: topicRows.filter(t => t.pillar_id === p.id),
  }));
  _taxonomy = {
    pillars:   shaped,
    topics:    topicRows,
    pillarMap: Object.fromEntries(shaped.map(p => [p.id, p])),
    topicMap:  Object.fromEntries(topicRows.map(t => [t.id, t])),
    proposedPillarMap: Object.fromEntries((proposedPillars || []).map(p => [p.id, p])),
    proposedTopicMap:  Object.fromEntries((proposedTopics  || []).map(t => [t.id, t])),
    loaded:    true,
  };
  return _taxonomy;
}

function ensureTaxonomy() {
  if (!_taxonomyPromise) _taxonomyPromise = loadTaxonomy();
  return _taxonomyPromise;
}
// Warm the cache as soon as the module loads so normalize() has data fast.
ensureTaxonomy();

// Per-instance suffix so multiple useTaxonomy() consumers on one page don't
// collide on a shared realtime topic (Supabase throws "cannot add
// postgres_changes callbacks ... after subscribe()" when two channels share a
// name). The PeerReview page mounts this hook several times.
let _taxonomyChannelSeq = 0;

// React hook exposing the ratified taxonomy tree.  `pillars` is ordered with a
// positional `n` and a nested `topics` array; `pillarMap`/`topicMap` index by id.
export function useTaxonomy() {
  const [tax, setTax] = useState(_taxonomy);
  useEffect(() => {
    let cancelled = false;
    ensureTaxonomy().then(t => { if (!cancelled) setTax({ ...t }); });

    const ch = supabase
      .channel(`taxonomy-${++_taxonomyChannelSeq}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pillars' }, () => {
        _taxonomyPromise = null;
        ensureTaxonomy().then(t => { if (!cancelled) setTax({ ...t }); });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'topics' }, () => {
        _taxonomyPromise = null;
        ensureTaxonomy().then(t => { if (!cancelled) setTax({ ...t }); });
      })
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(ch); };
  }, []);
  return tax;
}

// ── Consensus rules ───────────────────────────────────────────────────────────
//
// All thresholds scale with the live active-peer count so the system remains
// fair as the network grows.  Tier I (declassified / peer-reviewed) requires
// a higher bar to canonize AND to deprecate — it is harder to add but also
// harder to remove.
//
// Fallback used only when the live peer count has not yet loaded from the
// contract (e.g. during initial page load or in dev mode without a contract).
// All hot paths pass the live count explicitly — this value should never
// influence a real state transition.
export const ACTIVE_PEER_COUNT = 1;

export function canonizeThreshold(tier, peers = ACTIVE_PEER_COUNT) {
  const pct = { 1: 0.60, 2: 0.55, 3: 0.51 };
  return Math.max(1, Math.ceil(peers * (pct[tier] ?? 0.55)));
}

export function expelThreshold(peers = ACTIVE_PEER_COUNT) {
  return Math.max(1, Math.ceil(peers * 0.25));
}

export function deprecateThreshold(tier, peers = ACTIVE_PEER_COUNT) {
  const pct = { 1: 0.65, 2: 0.60, 3: 0.55 };
  return Math.max(1, Math.ceil(peers * (pct[tier] ?? 0.60)));
}

// Strict majority floor(n/2)+1, mirrors EvidenceConsensus.taxonomyThreshold().
export function taxonomyThreshold(peers = ACTIVE_PEER_COUNT) {
  return Math.floor(peers / 2) + 1;
}

// Effective gate to ratify a founding bundle: at least taxonomyThreshold AND at
// least the tier's canonizeThreshold. Mirrors EvidenceConsensus.bundleThreshold().
export function bundleThreshold(tier, peers = ACTIVE_PEER_COUNT) {
  return Math.max(taxonomyThreshold(peers), canonizeThreshold(tier, peers));
}

// How many days from submission before pending evidence lapses
export const PENDING_WINDOW_DAYS = 30;
// How many days a challenge stays open before it resolves by defense
export const CHALLENGE_WINDOW_DAYS = 21;

export function daysRemaining(isoTimestamp, windowDays) {
  if (!isoTimestamp) return null;
  const ms = new Date(isoTimestamp).getTime() + windowDays * 86_400_000 - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

// Human-readable label for each status
export const STATUS_LABEL = {
  queued:     'In peer review',
  pending:    'In peer review',
  canon:      'Canon',
  approved:   'Canon',   // legacy
  expelled:   'Expelled',
  rejected:   'Expelled', // legacy
  lapsed:     'Lapsed',
  contested:  'Contested',
  deprecated: 'Deprecated',
  reaffirmed: 'Reaffirmed',
};

// ── Row normalization ────────────────────────────────────────────────────────
function normalize(row) {
  const pillar = _taxonomy.pillarMap[row.pillar_id] || {};
  const topic  = _taxonomy.topicMap[row.topic_id]   || {};
  return {
    ...row,
    pillarId:    row.pillar_id,
    pillarTitle: pillar.title || row.pillar_id,
    pillarNum:   pillar.n || '??',
    topicId:     row.topic_id,
    topicTitle:  topic.title || row.topic_id,
  };
}

// Normalize a `bindings` row joined to its parent `evidence`.  The result is a
// flat "binding view": `id` is the EVIDENCE uuid (so on-chain submit + copy-id
// keep working), `bindingId`/`bindingHash` identify the (evidence × topic)
// voting unit, and the per-binding lifecycle/tallies sit at the top level. The
// evidence content (title/source/tier/…) is flattened from the join.
function normalizeBinding(row) {
  const ev     = row.evidence || {};
  const pillar = _taxonomy.pillarMap[row.pillar_id] || {};
  const topic  = _taxonomy.topicMap[row.topic_id]   || {};
  return {
    // binding identity + lifecycle
    bindingId:    row.id,
    bindingHash:  row.binding_hash,
    status:       row.status,
    approve_count:   row.approve_count,
    reject_count:    row.reject_count,
    challenge_votes: row.challenge_votes,
    defense_votes:   row.defense_votes,
    challenge_threshold: row.challenge_threshold,
    challenge_reason:    row.challenge_reason,
    deprecated_reason:   row.deprecated_reason,
    submitted_at:        row.submitted_at,
    reviewed_at:         row.reviewed_at,
    canon_at:            row.canon_at,
    challenged_at:       row.challenged_at,
    deprecated_at:       row.deprecated_at,
    submitted_onchain:    row.submitted_onchain,
    submitted_onchain_at: row.submitted_onchain_at,
    submission_tx_hash:   row.submission_tx_hash,
    queued_at:            row.queued_at,
    queue_priority:       row.queue_priority ?? 0,
    attestations:         row.attestations,
    // taxonomy
    pillarId:    row.pillar_id,
    pillarTitle: pillar.title || row.pillar_id,
    pillarNum:   pillar.n || '??',
    topicId:     row.topic_id,
    topicTitle:  topic.title || row.topic_id,
    // evidence content (id = evidence uuid)
    id:        row.evidence_id,
    evidenceId: row.evidence_id,
    tier:      ev.tier,
    type:      ev.type,
    title:     ev.title,
    source:    ev.source,
    year:      ev.year,
    excerpt:   ev.excerpt,
    body:      ev.body,
    quote:     ev.quote,
    link:      ev.link,
    tags:      ev.tags || [],
    content_hash: ev.content_hash,
  };
}

// Columns selected from the `bindings` table, with the parent evidence joined.
const BINDING_SELECT =
  '*, evidence:evidence_id(id, tier, type, title, source, year, excerpt, body, quote, link, tags, content_hash)';

const PAGE_SIZE = 24;

const VISIBLE_STATUSES = ['canon', 'approved', 'reaffirmed', 'contested', 'deprecated'];
const CANON_STATUSES   = ['canon', 'approved', 'reaffirmed'];

// Statuses included in numeric tallies — VISIBLE_STATUSES minus 'deprecated',
// so no count ever reflects evidence the network has retired.
const COUNTED_STATUSES = VISIBLE_STATUSES.filter(s => s !== 'deprecated');

// Substring search against the generated `search_text` column, which
// concatenates title, source, excerpt, body, quote, and tags (see migration
// 20260517000000_evidence_search_text.sql). Each whitespace-separated term
// must appear somewhere in that surface — so "tao physics" only matches rows
// containing both. We avoid textSearch('fts', …) because it requires exact
// stemmed-token matches and silently drops partial words like "psych".
function applyTextSearch(q, raw, col = 'search_text') {
  const trimmed = (raw || '').trim();
  if (!trimmed) return q;
  const terms = trimmed
    .split(/\s+/)
    .map(t => t.replace(/[,()*"%\\]/g, ''))
    .filter(Boolean);
  for (const term of terms) {
    q = q.ilike(col, `%${term}%`);
  }
  return q;
}

// ── Archive hook  (canon, reaffirmed, contested, deprecated) ─────────────────
//
// Views without a text search (default, or a tier-only filter) fetch all
// matching rows so the Pillar → Topic grouping stays unbroken — a tier filter
// narrows the tree, it does not flatten it.  A text search (or an explicit
// topic filter) paginates at PAGE_SIZE for the flat results list.  Rows are
// always ordered pillar → topic → id so nested grouping stays stable.
//
export function useEvidence(searchQuery = '', tier = 'all', topic = 'all') {
  const [items, setItems]     = useState([]);
  const [total, setTotal]     = useState(null);
  const [page, setPage]       = useState(0);
  const [loading, setLoading] = useState(true);

  const isPaged = !!searchQuery.trim() || topic !== 'all';

  // The archive is now a list of canon (evidence × topic) BINDINGS — the same
  // evidence appears once per topic it has been canonized under. Text + tier
  // filter the joined evidence (inner join); topic filters the binding.
  const buildQuery = (counted) => {
    const trimmed = searchQuery.trim();
    let q = supabase
      .from('bindings')
      .select(BINDING_SELECT.replace('evidence:evidence_id(', 'evidence:evidence_id!inner(') + ', topic:topic_id!inner(status)',
              counted ? { count: 'exact' } : undefined)
      .in('status', VISIBLE_STATUSES)
      // Exclude bindings under a RETIRED topic/pillar — the archive only shows
      // (and counts) evidence under the live canon taxonomy.
      .eq('topic.status', 'ratified');
    q = applyTextSearch(q, trimmed, 'evidence.search_text');
    if (tier !== 'all')  q = q.eq('evidence.tier', parseInt(tier, 10));
    if (topic !== 'all') q = q.eq('topic_id', topic);
    return q
      .order('pillar_id', { ascending: true })
      .order('topic_id', { ascending: true })
      .order('evidence_id', { ascending: true });
  };

  useEffect(() => {
    let cancelled = false;

    const load = (showLoading) => {
      if (showLoading) setLoading(true);
      return ensureTaxonomy().then(() => {
        let q = buildQuery(isPaged);
        if (isPaged) q = q.range(0, PAGE_SIZE - 1);
        return q;
      }).then(({ data, count }) => {
        if (cancelled) return;
        setItems((data || []).map(normalizeBinding));
        if (isPaged) setTotal(count ?? 0);
        setLoading(false);
      });
    };

    setPage(0);
    setTotal(null);
    load(true);

    let ch = null;
    if (!isPaged) {
      const debouncedRefetch = debounce(() => load(false), 350);
      ch = supabase
        .channel('evidence-archive-live')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'bindings' }, debouncedRefetch)
        .subscribe();
    }

    return () => {
      cancelled = true;
      if (ch) supabase.removeChannel(ch);
    };
  }, [searchQuery, tier, topic]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = () => {
    const next = page + 1;
    setPage(next);
    setLoading(true);

    buildQuery(false)
     .range(next * PAGE_SIZE, next * PAGE_SIZE + PAGE_SIZE - 1)
     .then(({ data }) => {
       setItems(prev => [...prev, ...(data || []).map(normalizeBinding)]);
       setLoading(false);
     });
  };

  const hasMore = isPaged && total !== null && items.length < total;

  return { evidence: items, loading, total, hasMore, loadMore };
}

// ── Pending taxonomy hook — proposed (not yet ratified) pillars + topics ─────
//
// The Peer Review Taxonomy surface reads these off-chain proposal rows; live
// endorsement counts are read separately from the contract.  Realtime keeps the
// list fresh as proposals land and the indexer flips them to ratified.
export function usePendingTaxonomy() {
  const [pillars, setPillars] = useState([]);
  const [topics, setTopics]   = useState([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(() => {
    return Promise.all([
      supabase.from('pillars').select('*').eq('status', 'proposed').order('created_at', { ascending: true }),
      supabase.from('topics').select('*').eq('status', 'proposed').order('created_at', { ascending: true }),
    ]).then(([p, t]) => {
      setPillars(p.data || []);
      setTopics(t.data || []);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    refetch();
    const ch = supabase
      .channel('pending-taxonomy')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pillars' }, () => refetch())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'topics'  }, () => refetch())
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [refetch]);

  return { pillars, topics, loading, refetch };
}

// Propose a taxonomy node bundled with its founding evidence (off-chain rows).
//
// Called AFTER the on-chain proposePillar / proposeTopic tx has confirmed, so
// nothing is written off-chain for a rejected or reverted proposal (no orphaned
// 'proposed' rows). The caller mints the evidence id client-side BEFORE the tx
// (it is an input to the on-chain call) and passes it back here so the inserted
// rows carry the exact same id the chain committed to. The indexer's reorg
// buffer (head − CONFIRMATIONS blocks) guarantees these rows exist before it
// reconciles the ratification block, so it still flips them proposed → ratified
// / pending → canon by matching node_hash / binding_hash.
//
// A taxonomy node is never empty: a pillar carries a founding topic + evidence,
// a topic carries a founding evidence. Hashing (node_hash, meta_hash,
// binding_hash, evidenceId) is computed by the caller and passed in, so this
// module stays ethers-free.
//
// `bundle`:
//   kind:        'pillar' | 'topic'
//   pillar:      { id, node_hash, title, tag, blurb, meta_hash }   (kind === 'pillar')
//   topic:       { id, pillar_id, node_hash, title, blurb, meta_hash }
//   evidence:    { type, tier, title, source, year, excerpt, link, tags }
//   evidenceId:  client-minted evidence uuid (the same id passed on-chain)
//   bindingHash: the on-chain bindingId hash for (evidenceId, foundingTopic)
//   proposed_by: wallet address (or null)
//
// Returns { evidenceId, bindingId } on success, or { error }. Rows are inserted
// in FK order (pillar → topic → evidence → binding).
export async function proposeTaxonomyBundle(bundle) {
  const { kind, pillar, topic, evidence, proposed_by, evidenceId, bindingHash } = bundle;

  if (kind === 'pillar') {
    const { error: pErr } = await supabase.from('pillars').insert({
      id: pillar.id, node_hash: pillar.node_hash, title: pillar.title.trim(),
      tag: pillar.tag?.trim() || null, blurb: pillar.blurb?.trim() || null,
      status: 'proposed', meta_hash: pillar.meta_hash, proposed_by: proposed_by || null,
    });
    if (pErr) return { error: pErr };
  }

  const { error: tErr } = await supabase.from('topics').insert({
    id: topic.id, pillar_id: topic.pillar_id, node_hash: topic.node_hash, title: topic.title.trim(),
    blurb: topic.blurb?.trim() || null,
    status: 'proposed', meta_hash: topic.meta_hash, proposed_by: proposed_by || null,
  });
  if (tErr) return { error: tErr };

  const { error: eErr } = await supabase.from('evidence').insert({
    id: evidenceId,
    type: evidence.type, tier: Number(evidence.tier),
    pillar_id: topic.pillar_id, topic_id: topic.id,
    title: evidence.title.trim(),
    source: evidence.source?.trim() || null,
    year: evidence.year?.trim() || null,
    excerpt: evidence.excerpt?.trim() || null,
    link: evidence.link?.trim() || null,
    tags: evidence.tags || [],
    status: 'pending',
  });
  if (eErr) return { error: eErr };

  const { data: b, error: bErr } = await supabase.from('bindings').insert({
    evidence_id: evidenceId, pillar_id: topic.pillar_id, topic_id: topic.id,
    binding_hash: bindingHash, status: 'pending', submitted_onchain: false,
  }).select('id').single();
  if (bErr) return { error: bErr };

  return { evidenceId, bindingId: b?.id || null };
}

// ── Tier counts hook — unfiltered totals for Hero stats ───────────────────────
//
// Realtime-subscribed: the global + per-tier totals are the page's heartbeat, so
// any evidence insert/status change refetches (debounced) and the hero count
// ticks live. Deprecated rows are excluded (COUNTED_STATUSES).
export function useTierCounts() {
  const [counts, setCounts] = useState({ total: 0, tier1: 0, tier2: 0, tier3: 0 });

  useEffect(() => {
    let cancelled = false;
    // Counts are over canon BINDINGS (one evidence can count under several
    // topics); deprecated bindings are excluded (COUNTED_STATUSES). Tier lives
    // on the joined evidence, so we inner-join and filter on evidence.tier. The
    // topic inner-join with status='ratified' drops any binding whose topic (or,
    // transitively, pillar) was RETIRED — counts only ever reflect the live canon.
    const fetchCounts = () => {
      const base = () => supabase
        .from('bindings')
        .select('evidence:evidence_id!inner(tier),topic:topic_id!inner(status)', { count: 'exact', head: true })
        .in('status', COUNTED_STATUSES)
        .eq('topic.status', 'ratified');
      Promise.all([
        base(),
        base().eq('evidence.tier', 1),
        base().eq('evidence.tier', 2),
        base().eq('evidence.tier', 3),
      ]).then(([all, t1, t2, t3]) => {
        if (cancelled) return;
        setCounts({
          total: all.count ?? 0,
          tier1: t1.count  ?? 0,
          tier2: t2.count  ?? 0,
          tier3: t3.count  ?? 0,
        });
      });
    };
    fetchCounts();
    const debouncedRefetch = debounce(fetchCounts, 300);
    const ch = supabase
      .channel('tier-counts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bindings' }, debouncedRefetch)
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(ch); };
  }, []);

  return counts;
}

// ── Binding stats hook — public peer-network counters (no wallet needed) ──────
//
// Powers the Peer Review connect-screen hero stats: how many bindings are in
// review, contested, and filed in the archive. Realtime-subscribed.
export function useBindingCounts() {
  const [counts, setCounts] = useState({ pending: 0, contested: 0, archived: 0 });

  useEffect(() => {
    let cancelled = false;
    const fetchCounts = () => {
      const base = () => supabase.from('bindings').select('*', { count: 'exact', head: true });
      Promise.all([
        // pending stays unfiltered — it includes founding evidence of PROPOSED
        // nodes (topic not yet ratified), which is legitimately in review.
        base().eq('status', 'pending'),
        base().eq('status', 'contested'),
        // archived is the canon count: drop bindings under a retired topic/pillar.
        supabase.from('bindings')
          .select('topic:topic_id!inner(status)', { count: 'exact', head: true })
          .in('status', CANON_STATUSES)
          .eq('topic.status', 'ratified'),
      ]).then(([p, c, a]) => {
        if (cancelled) return;
        setCounts({ pending: p.count ?? 0, contested: c.count ?? 0, archived: a.count ?? 0 });
      });
    };
    fetchCounts();
    const debouncedRefetch = debounce(fetchCounts, 300);
    const ch = supabase
      .channel('binding-counts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bindings' }, debouncedRefetch)
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(ch); };
  }, []);

  return counts;
}

// ── Recent-evidence hook — newest visible entries for the floating live feed ──
//
// Powers the bottom-right "Live" feed: the most recent non-deprecated entries,
// realtime-subscribed so a new submission appears at the top without a refresh.
// ── Peer handle map — addr → handle for display fallback ─────────────────────
//
// A peer's handle is canonical on-chain; it is snapshotted into
// attestations.peer_handle on the signed write path, and emitted in the
// PeerNominated / NomineeVerified / PeerAdded chain events. When a row carries
// no handle (a freshly-nominated peer who hasn't attested yet, or an indexer
// gap row) the feed would show a bare address. This builds an addr→handle map
// from both sources — attestations first, then handle-carrying chain events
// for any address the attestation set didn't cover — so the same peer's known
// handle can stand in. Pure off-chain, no wallet/RPC, so it works for
// logged-out visitors on the home feed.
export function usePeerHandleMap() {
  const [map, setMap] = useState({});
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      supabase
        .from('attestation_log_view')
        .select('peer_addr, peer_handle')
        .not('peer_handle', 'is', null)
        .order('created_at', { ascending: false })
        .limit(2000),
      supabase
        .from('chain_events')
        .select('peer_addr, payload')
        .in('event_name', ['PeerNominated', 'NomineeVerified', 'PeerAdded'])
        .order('block_number', { ascending: false })
        .order('log_index', { ascending: false })
        .limit(2000),
    ]).then(([att, ce]) => {
      if (cancelled) return;
      const m = {};
      for (const r of att.data || []) {
        const a = r.peer_addr?.toLowerCase();
        if (a && r.peer_handle && !m[a]) m[a] = r.peer_handle;
      }
      for (const r of ce.data || []) {
        const a = r.peer_addr?.toLowerCase();
        const h = r.payload?.handle;
        if (a && h && !m[a]) m[a] = h;
      }
      setMap(m);
    });
    return () => { cancelled = true; };
  }, []);
  return map;
}

// ── Recent-votes hook — newest signed peer attestations for the home page ─────
//
// Each row is one peer's on-chain, EIP-712-signed verdict (approve / reject /
// challenge / defend / endorse) on a specific evidence under a topic, with the
// settling tx_hash. This is the public proof that consensus is live — it powers
// the "A public record" vote feed. Realtime-subscribed to attestation inserts.
export function useRecentVotes(limit = 6) {
  const [votes, setVotes] = useState([]);

  useEffect(() => {
    let cancelled = false;
    const refetch = () =>
      supabase
        .from('attestation_log_view')
        // select('*') so each row carries the Vote-digest fields the proof modal
        // needs (round / note_hash / binding_hash / node_hash). An explicit list
        // silently drifts from AttestationVerifier and breaks signer recovery.
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit)
        .then(({ data }) => { if (!cancelled) setVotes(data || []); });

    refetch();
    const debouncedRefetch = debounce(refetch, 300);
    const ch = supabase
      .channel('recent-votes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attestations' }, debouncedRefetch)
      .subscribe();
    return () => { cancelled = true; supabase.removeChannel(ch); };
  }, [limit]);

  return votes;
}

// Trailing-edge debounce. Used to coalesce realtime bursts (e.g. 30
// attestations landing in a 200ms window) into a single refetch.
function debounce(fn, ms = 200) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
}

// ── Pending review queue  (bindings awaiting peer attestations) ──────────────
//
// One row per (evidence × topic) binding in `pending` review, on-chain.
// Returned in the SHARED review order every peer agrees on — public boost
// priority first, then FIFO by submission, then binding id as a deterministic
// tiebreak. Both queue_priority and submitted_at are frozen once a binding is
// `pending` (boosting only happens while `queued`), so the order is stable and
// only changes when an item leaves on network resolution. The per-peer batch
// view is derived from this in PeerReview.
export function usePendingBindings() {
  const [queue, setQueue]   = useState([]);
  const [loading, setLoading] = useState(true);

  const refetch = () =>
    ensureTaxonomy().then(() => supabase
      .from('bindings')
      .select(BINDING_SELECT + ', attestations(*)')
      .eq('status', 'pending')
      .eq('submitted_onchain', true)  // hide bindings not yet on-chain
      .order('queue_priority', { ascending: false })
      .order('submitted_at', { ascending: true })
      .order('id', { ascending: true }))
      .then(({ data }) => {
        setQueue((data || []).map(normalizeBinding));
        setLoading(false);
      });

  useEffect(() => {
    refetch();
    const debouncedRefetch = debounce(refetch, 200);
    const ch = supabase
      .channel('pending-queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bindings', filter: 'status=eq.pending' }, debouncedRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attestations',
                                filter: 'phase=eq.review' }, debouncedRefetch)
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, []);

  return { queue, loading, refetch };
}

// ── Submission queue (bindings parked behind a full active-review set) ────────
//
// One row per (evidence × topic) binding in the `queued` state, on-chain but not
// yet promoted into review. Ordered the way the keeper promotes and the public
// archive lists: highest public boost first, then oldest-queued (FIFO). Public
// boosts and keeper promotions both flow through realtime.
export function useQueuedBindings() {
  const [queue, setQueue]     = useState([]);
  const [loading, setLoading] = useState(true);

  const refetch = () =>
    ensureTaxonomy().then(() => supabase
      .from('bindings')
      .select(BINDING_SELECT)
      .eq('status', 'queued')
      .eq('submitted_onchain', true)
      .order('queue_priority', { ascending: false })
      .order('queued_at', { ascending: true }))
      .then(({ data }) => {
        setQueue((data || []).map(normalizeBinding));
        setLoading(false);
      });

  useEffect(() => {
    refetch();
    const debouncedRefetch = debounce(refetch, 200);
    const ch = supabase
      .channel('submission-queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bindings', filter: 'status=eq.queued' }, debouncedRefetch)
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, []);

  return { queue, loading, refetch };
}

// Fetch a single binding (joined to its evidence) as a normalized preview
// object — lets places that only hold ids (e.g. the Vote history) pop the full
// evidence card. Falls back to the parent evidence + the given pillar/topic for
// legacy attestation rows that predate binding_id.
export async function fetchBindingPreview({ bindingId = null, evidenceId = null, pillarId = null, topicId = null }) {
  await ensureTaxonomy();
  if (bindingId) {
    const { data } = await supabase.from('bindings').select(BINDING_SELECT).eq('id', bindingId).maybeSingle();
    if (data) return normalizeBinding(data);
  }
  if (!evidenceId) return null;
  const { data: ev } = await supabase.from('evidence').select('*').eq('id', evidenceId).maybeSingle();
  if (!ev) return null;
  return normalizeBinding({
    id: bindingId, binding_hash: null, status: ev.status,
    pillar_id: pillarId, topic_id: topicId, evidence_id: ev.id, evidence: ev,
  });
}

// Tamper alerts — rows the audit-content-hash edge function writes when an
// evidence row's stored content_hash no longer matches its canonical hash.
// Live-updated via realtime so a fresh alert appears without needing the
// operator to refresh the page. The joined title field lets the dashboard
// render the affected record's name inline.
export function useTamperAlerts(limit = 20) {
  const [alerts, setAlerts]   = useState([]);
  const [loading, setLoading] = useState(true);

  const refetch = () => {
    supabase
      .from('tamper_alerts')
      .select('*, evidence(title)')
      .order('detected_at', { ascending: false })
      .limit(limit)
      .then(({ data }) => {
        setAlerts(data || []);
        setLoading(false);
      });
  };

  useEffect(() => {
    refetch();
    const debouncedRefetch = debounce(refetch, 200);
    const ch = supabase
      .channel('tamper-alerts-evidence')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tamper_alerts' }, debouncedRefetch)
      .subscribe();
    return () => supabase.removeChannel(ch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit]);

  return { alerts, loading };
}

// Edge function heartbeat — populated by chain-indexer-evidence + audit-content-hash
// on every run. The UI surfaces stale rows so operators can spot a silently
// failing cron without needing to query SQL directly.
export function useHeartbeats() {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);

  const refetch = () => {
    supabase
      .from('edge_function_heartbeat')
      .select('*')
      .order('function_name', { ascending: true })
      .then(({ data }) => {
        setRows(data || []);
        setLoading(false);
      });
  };

  useEffect(() => {
    refetch();
    // Unique channel name per mount so multiple consumers on one page don't
    // collide on a shared topic (e.g. the indexer pill + the system strip).
    const ch = supabase
      .channel(`heartbeats-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'edge_function_heartbeat' }, () => refetch())
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, []);

  return { rows, loading };
}

// Derive an edge function's live health from its heartbeat row. States:
// ok | error | stale | unknown. `staleMs` is the tolerance before a silent
// failure (cron not firing / never completing) is surfaced — tune it per job's
// cadence (indexer 1 min, keeper 5 min, audit daily).
export function deriveHeartbeatHealth(row, staleMs, label, now = Date.now()) {
  if (!row) return { state: 'unknown', label: `${label} status unknown`, short: '—' };
  const attempt = row.last_attempt ? Date.parse(row.last_attempt) : 0;
  const success = row.last_success ? Date.parse(row.last_success) : 0;
  // Cron/edge isn't even attempting — the worst, silent failure.
  if (now - attempt > staleMs) return { state: 'stale', label: `${label} stalled`, short: 'stalled' };
  // It's attempting, but the last completed run errored.
  if (row.last_status === 'error') return { state: 'error', label: `${label} error`, short: 'error' };
  // Attempting but never completing a successful run.
  if (now - success > staleMs) return { state: 'stale', label: `${label} stalled`, short: 'stalled' };
  return { state: 'ok', label: `${label} ok`, short: 'live' };
}

// Per-job staleness tolerances, derived from each cron cadence (~3–4 missed
// ticks before alarming). See supabase/migrations cron.schedule calls.
const HEALTH_SPECS = [
  { name: 'chain-indexer-evidence', label: 'Indexer', staleMs: 4 * 60 * 1000 },        // every 1 min
  { name: 'audit-content-hash',     label: 'Audit',   staleMs: 30 * 60 * 60 * 1000 },  // daily 03:17 UTC
];

// Shared ticking clock so health hooks recompute staleness even when no new
// heartbeat row arrives (the whole point — catch a silently dead cron).
function useNowTick(ms = 30000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// Live indexer health for the public-facing badges (Evidence hero + log tab).
export function useIndexerHealth() {
  const { rows, loading } = useHeartbeats();
  const now = useNowTick();
  const spec = HEALTH_SPECS[0];
  const row = rows.find(r => r.function_name === spec.name);
  return { ...deriveHeartbeatHealth(row, spec.staleMs, spec.label, now), lastSuccess: row?.last_success || null, loading };
}

// All three cron-driven edge functions' health in one subscription, for the
// operator health strip on the peer-review surface.
export function useSystemHealth() {
  const { rows, loading } = useHeartbeats();
  const now = useNowTick();
  const services = HEALTH_SPECS.map(spec => {
    const row = rows.find(r => r.function_name === spec.name);
    return {
      name: spec.name,
      service: spec.label,  // bare name ("Audit") — the strip pairs it with `short`
      ...deriveHeartbeatHealth(row, spec.staleMs, spec.label, now),  // adds state, label ("Audit ok"), short ("live")
      lastSuccess: row?.last_success || null,
    };
  });
  return { services, loading };
}

// Count of unresolved tamper alerts (content/hash drift caught by the daily
// audit). Realtime-subscribed so a freshly opened alert lights up immediately.
export function useTamperAlertCount() {
  const [count, setCount] = useState(null);
  useEffect(() => {
    const refetch = () => supabase
      .from('tamper_alerts')
      .select('id', { count: 'exact', head: true })
      .is('resolved_at', null)
      .then(({ count }) => setCount(count ?? 0));
    refetch();
    const ch = supabase
      .channel(`tamper-alerts-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tamper_alerts' }, () => refetch())
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, []);
  return count;
}

// Chain events from the indexer, for the public activity feed.
//
// Paginated: loads `pageSize` rows at a time (newest block first) and exposes
// `loadMore` / `hasMore` so the UI can append the next page on click.
const CHAIN_EVENTS_PAGE = 30;

export function useChainEvents(pageSize = CHAIN_EVENTS_PAGE, query = '', eventNames = [], extraAddrs = []) {
  const [events, setEvents]   = useState([]);
  const [page, setPage]       = useState(0);
  const [total, setTotal]     = useState(null);
  const [loading, setLoading] = useState(true);

  // Strip PostgREST-special chars before composing the OR filter.
  const q = query.trim().replace(/[,()*"]/g, '');
  // Stable keys so the effect doesn't refire on a fresh array of the same values.
  const namesKey = eventNames.slice().sort().join(',');
  const addrsKey = extraAddrs.slice().sort().join(',');

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const applyFilters = (req) => {
    if (namesKey) req = req.in('event_name', namesKey.split(','));
    if (q || addrsKey) {
      const ors = [];
      if (q) {
        ors.push(`peer_addr.ilike.%${q}%`);
        // evidence_id is a `uuid` column; PostgREST doesn't support `ilike`
        // on uuid columns inside or(), so we only match a fully-typed UUID.
        if (UUID_RE.test(q)) ors.push(`evidence_id.eq.${q.toLowerCase()}`);
      }
      if (addrsKey) ors.push(`peer_addr.in.(${addrsKey})`);
      if (ors.length) req = req.or(ors.join(','));
    }
    return req;
  };

  // Attach evidence titles by evidence_id so the chain log renders the human
  // identifier instead of a bare UUID. One extra query per page.
  const enrichWithTitles = async (rows) => {
    const ids = Array.from(new Set((rows || []).map(r => r.evidence_id).filter(Boolean)));
    if (!ids.length) return (rows || []).map(r => ({ ...r, evidence: null }));
    const { data: evs } = await supabase
      .from('evidence')
      .select('id, title')
      .in('id', ids);
    const titles = Object.fromEntries((evs ?? []).map(e => [e.id, e]));
    return (rows || []).map(r => ({ ...r, evidence: titles[r.evidence_id] || null }));
  };

  const refetch = useCallback(() => {
    setLoading(true);
    setPage(0);
    setTotal(null);
    return applyFilters(
      supabase
        .from('chain_events')
        .select('*', { count: 'estimated' })
        .order('block_number', { ascending: false })
        .order('log_index',    { ascending: false })
    )
      .range(0, pageSize - 1)
      .then(async ({ data, count }) => {
        const enriched = await enrichWithTitles(data || []);
        setEvents(enriched);
        setTotal(count ?? null);
        setLoading(false);
      });
  // applyFilters closes over q/namesKey/addrsKey; pageSize is a dep too.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize, q, namesKey, addrsKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPage(0);
    setTotal(null);

    applyFilters(
      supabase
        .from('chain_events')
        .select('*', { count: 'estimated' })
        .order('block_number', { ascending: false })
        .order('log_index',    { ascending: false })
    )
      .range(0, pageSize - 1)
      .then(async ({ data, count }) => {
        if (cancelled) return;
        const enriched = await enrichWithTitles(data || []);
        if (cancelled) return;
        setEvents(enriched);
        setTotal(count ?? null);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [pageSize, q, namesKey, addrsKey]);

  const loadMore = () => {
    const next = page + 1;
    setPage(next);
    setLoading(true);

    applyFilters(
      supabase
        .from('chain_events')
        .select('*')
        .order('block_number', { ascending: false })
        .order('log_index',    { ascending: false })
    )
      .range(next * pageSize, next * pageSize + pageSize - 1)
      .then(async ({ data }) => {
        const enriched = await enrichWithTitles(data || []);
        setEvents(prev => [...prev, ...enriched]);
        setLoading(false);
      });
  };

  const hasMore = total === null ? events.length === (page + 1) * pageSize : events.length < total;

  return { events, loading, hasMore, loadMore, total, refetch };
}

// ── Contested bindings hook  (canon bindings under active challenge) ─────────
//
// Returned in the SHARED challenge order every peer agrees on — oldest challenge
// first (FIFO by `challenged_at`), then binding id as a deterministic tiebreak.
// This mirrors the pending review queue: a stable shared order the per-peer
// batch view in PeerReview slices ≤3 from, so peers work the contest front-first
// and consensus on the oldest challenges is reached before newer ones pile in.
export function useContestedBindings() {
  const [contested, setContested] = useState([]);
  const [loading, setLoading]     = useState(true);

  const refetch = () =>
    ensureTaxonomy().then(() => supabase
      .from('bindings')
      .select(BINDING_SELECT + ', attestations(*)')
      .eq('status', 'contested')
      .order('challenged_at', { ascending: true })
      .order('id', { ascending: true }))
      .then(({ data }) => {
        setContested((data || []).map(normalizeBinding));
        setLoading(false);
      });

  useEffect(() => {
    refetch();
    const debouncedRefetch = debounce(refetch, 200);
    const ch = supabase
      .channel('contested-queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bindings',
                                filter: 'status=eq.contested' }, debouncedRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attestations',
                                filter: 'phase=eq.challenge' }, debouncedRefetch)
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, []);

  return { contested, loading, refetch };
}

// ── Canon evidence hook  (for the "open challenge" browser) ─────────────────
//
// Paginated + search-filtered.  Without this, opening the Challenges tab
// pulled the entire canon archive client-side on every mount — fine at 50
// items, painful at 5000.  Defaults to 50 items per page; the caller can
// drive `query` from a search input and `loadMore` from a "Load more" button.
const CANON_PAGE = 50;

export function useCanonBindings(query = '') {
  const [canon, setCanon]     = useState([]);
  const [page, setPage]       = useState(0);
  const [total, setTotal]     = useState(null);
  const [loading, setLoading] = useState(true);

  const trimmed = (query ?? '').trim();

  const build = (counted) => {
    let q = supabase
      .from('bindings')
      .select(BINDING_SELECT.replace('evidence:evidence_id(', 'evidence:evidence_id!inner('),
              counted ? { count: 'estimated' } : undefined)
      .in('status', CANON_STATUSES);
    q = applyTextSearch(q, trimmed, 'evidence.search_text');
    return q.order('pillar_id', { ascending: true }).order('evidence_id', { ascending: true });
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPage(0);
    setTotal(null);
    ensureTaxonomy()
      .then(() => build(true).range(0, CANON_PAGE - 1))
      .then(({ data, count }) => {
        if (cancelled) return;
        setCanon((data || []).map(normalizeBinding));
        setTotal(count ?? null);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [trimmed]);

  const loadMore = () => {
    const next = page + 1;
    setPage(next);
    setLoading(true);
    build(false)
     .range(next * CANON_PAGE, next * CANON_PAGE + CANON_PAGE - 1)
     .then(({ data }) => {
       setCanon(prev => [...prev, ...(data || []).map(normalizeBinding)]);
       setLoading(false);
     });
  };

  const hasMore = total === null ? canon.length === (page + 1) * CANON_PAGE : canon.length < total;

  return { canon, loading, hasMore, loadMore, total };
}

// ── Attestation log hook ─────────────────────────────────────────────────────
//
// Paginated: loads `pageSize` rows at a time (newest first) and exposes
// `loadMore` / `hasMore` so the UI can append the next page on click instead
// of capping the visible log at the first chunk.
const ATTESTATION_PAGE = 30;

export function useAttestationLog(pageSize = ATTESTATION_PAGE, query = '', verdict = '') {
  const [log, setLog]         = useState([]);
  const [page, setPage]       = useState(0);
  const [total, setTotal]     = useState(null);
  const [loading, setLoading] = useState(true);

  // Sanitize the query before composing a PostgREST `or` filter: strip
  // characters that have special meaning in PostgREST/ilike syntax so they
  // can't break out of the pattern. Split on whitespace and require each
  // term to match somewhere — same per-term AND semantics as the Evidence
  // page (see applyTextSearch).
  const terms = query
    .trim()
    .replace(/[,()*"%\\]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  const termsKey = terms.join(' ');
  const v = ['approve', 'reject', 'challenge', 'defend'].includes(verdict) ? verdict : '';

  // We query the unified `vote_log_view` — `attestation_log_view` (review /
  // challenge / taxonomy endorse·reject) UNION the node/owner governance votes
  // (taxonomy retire + force-renounce) from `gov_votes`, so every public vote
  // shows in one feed (peer-registry membership votes stay in their own log).
  // The view flattens evidence.search_text + title + evidence_id::text onto each
  // row so a single per-term OR filter covers handle, address, the evidence
  // searchable surface, and the UUID (gov rows match on handle/address).
  const FROM_VIEW = 'vote_log_view';

  const applyFilters = (req) => {
    // 'endorse' (taxonomy) is the same act as 'approve' (review) — surface them
    // together under the Approve filter.
    if (v === 'approve') req = req.in('verdict', ['approve', 'endorse']);
    else if (v) req = req.eq('verdict', v);
    for (const term of terms) {
      req = req.or(
        `peer_handle.ilike.%${term}%,peer_addr.ilike.%${term}%,evidence_search_text.ilike.%${term}%,evidence_id_text.ilike.%${term}%`
      );
    }
    return req;
  };

  const refetch = useCallback(() => {
    setLoading(true);
    setPage(0);
    setTotal(null);
    return applyFilters(
      supabase
        .from(FROM_VIEW)
        .select('*', { count: 'estimated' })
        .order('created_at', { ascending: false })
    )
      .range(0, pageSize - 1)
      .then(({ data, count }) => {
        setLog(data || []);
        setTotal(count ?? null);
        setLoading(false);
      });
  // applyFilters closes over terms/v; pageSize is a dep too.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize, termsKey, v]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPage(0);
    setTotal(null);

    applyFilters(
      supabase
        .from(FROM_VIEW)
        .select('*', { count: 'estimated' })
        .order('created_at', { ascending: false })
    )
      .range(0, pageSize - 1)
      .then(({ data, count }) => {
        if (cancelled) return;
        setLog(data || []);
        setTotal(count ?? null);
        setLoading(false);
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize, termsKey, v]);

  const loadMore = () => {
    const next = page + 1;
    setPage(next);
    setLoading(true);

    applyFilters(
      supabase
        .from(FROM_VIEW)
        .select('*')
        .order('created_at', { ascending: false })
    )
      .range(next * pageSize, next * pageSize + pageSize - 1)
      .then(({ data }) => {
        setLog(prev => [...prev, ...(data || [])]);
        setLoading(false);
      });
  };

  const hasMore = total === null ? log.length === (page + 1) * pageSize : log.length < total;

  return { log, loading, hasMore, loadMore, total, refetch };
}

// ── Derived "consensus-reject" outcome rows ──────────────────────────────────
//
// The contract has no on-chain reject for taxonomy proposals — a node either
// ratifies at endorse threshold or sits Proposed until its 30-day window lapses.
// That leaves the public log without a "the network rejected this" moment, even
// when peers have signed enough off-chain dissents to make ratification
// arithmetically impossible.
//
// This hook fills that gap *honestly*: it derives a synthetic row from the
// real signed reject_node attestations. A proposal is considered consensus-
// rejected the moment its cumulative dissents reach `peers - need + 1`, where
// `need = bundleThreshold(tier, peers)` — i.e. fewer eligible endorsers remain
// than the threshold requires, so ratification is impossible regardless of how
// many of them later endorse. The synthetic row carries `derived: true` so the
// proof badge reads "Derived ✓" (not "On-chain" / "EIP-712"), and the timestamp
// is the crossing dissent's, so it sits at the moment consensus was reached.
//
// Nothing is fabricated: each dissent that produces this outcome remains an
// independently-verifiable row in the same log; this is a projection of them.
export function useDerivedConsensusRejects(activePeers, query = '', verdict = '') {
  const [rows, setRows] = useState([]);

  const terms = query.trim().replace(/[,()*"%\\]/g, '').split(/\s+/).filter(Boolean);
  const termsKey = terms.join(' ');
  const v = ['approve', 'reject', 'challenge', 'defend'].includes(verdict) ? verdict : '';

  useEffect(() => {
    if (!activePeers || activePeers < 1) { setRows([]); return; }
    // The verdict filter narrows the public log; reject-only filters keep our
    // row, approve/challenge/defend hide it.
    if (v && v !== 'reject') { setRows([]); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('vote_log_view')
        .select('*')
        .eq('phase', 'taxonomy')
        .eq('verdict', 'reject')
        .order('binding_hash', { ascending: true })
        .order('created_at',   { ascending: true });
      if (cancelled) return;
      const byBinding = new Map();
      for (const r of data || []) {
        const k = r.binding_hash;
        if (!k) continue;
        const arr = byBinding.get(k) || [];
        arr.push(r);
        byBinding.set(k, arr);
      }
      const haystack = (r) => [
        r.peer_handle, r.peer_addr, r.evidence_title, r.evidence_source,
        r.evidence_excerpt, r.evidence_link, r.pillar_title, r.topic_title,
        r.evidence_id != null ? String(r.evidence_id) : '',
      ].filter(Boolean).join(' ').toLowerCase();
      const out = [];
      for (const [bindingHash, dissents] of byBinding) {
        const tier = dissents.find(d => d.evidence_tier != null)?.evidence_tier;
        if (tier == null) continue;
        const need = bundleThreshold(Number(tier), activePeers);
        const rejectThreshold = activePeers - need + 1;
        if (rejectThreshold < 1 || dissents.length < rejectThreshold) continue;
        const crossing = dissents[rejectThreshold - 1];
        if (terms.length) {
          const hs = haystack(crossing);
          if (!terms.every(t => hs.includes(t.toLowerCase()))) continue;
        }
        out.push({
          ...crossing,
          id: `derived:${bindingHash}`,
          created_at: crossing.created_at,
          peer_addr: null,
          peer_handle: 'Network',
          verdict: 'reject',
          phase: 'taxonomy',
          eip712_sig: null,
          tx_hash: null,
          note: null,
          note_hash: null,
          round: null,
          proof_type: 'derived',
          derived: true,
          derived_dissents: dissents.length,
          derived_peers: activePeers,
          derived_need: need,
          derived_threshold: rejectThreshold,
        });
      }
      out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
      setRows(out);
    })();
    return () => { cancelled = true; };
  // termsKey + v close over the filter values used inside
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePeers, termsKey, v]);

  return rows;
}

// ── Network-row derivation descriptors ───────────────────────────────────────
//
// Every "Network" outcome row in the vote log (binding / taxonomy / challenge
// lifecycle) and in the peer registry log (verified / revoked / cancelled) is
// the contract's projection of underlying signed peer votes. A descriptor maps
// the outcome to:
//   • the queries that re-count the underlying signed votes (`queries`),
//   • a `thresholdFn(peers)` that derives the threshold from the active peer
//     count *at the moment of the event* (not the live count),
//   • a `moment` hint (block_number, txHash + event_name, or a pre-baked
//     payload) so the panel can resolve that historical peer count from the
//     chain_events mirror.
// Returns null for non-consensus Network rows (review timeouts, inactivity
// prunes, owner seeds) and for any signed-peer row.

// Mirror the on-chain threshold helpers from PeerGovernance.sol /
// EvidenceConsensus.sol — these are the formulas the contract used at the
// moment, so the panel's "what threshold did the contract need to cross" line
// matches what actually happened on-chain.
const NOMINEE_THRESHOLD = (peers) => Math.max(1, Math.floor(peers / 3) + 1);  // nomineeThreshold = peers/3 + 1
const REVOKE_THRESHOLD  = (peers) => Math.max(1, Math.ceil(peers / 2));       // revokeThreshold = ceil(peers/2)
const RETIRE_THRESHOLD  = (peers) => Math.max(1, Math.ceil((2 * peers) / 3)); // retireThreshold = ceil(2 peers/3)

// On-chain percentage tables, surfaced in the panel's "Contract formula"
// row so the math the contract ran is visible to the user. (See
// _canonizeThresholdAt / _deprecateThresholdAt in EvidenceConsensus.sol.)
const TIER_CANONIZE_PCT  = { 1: 60, 2: 55, 3: 51 };
const TIER_DEPRECATE_PCT = { 1: 65, 2: 60, 3: 55 };

// One entry per on-chain threshold helper. Used to build the descriptor's
// `thresholdDoc` — the expandable "Contract formula" row in the panel reads
// from here so the displayed math, contract source line, and rationale are
// the actual ones from the deployed contract.
function thresholdDoc(kind, tier = null) {
  switch (kind) {
    case 'nominee': return {
      formula:    'floor(peers / 3) + 1',
      fn:         'nomineeThreshold()',
      file:       'PeerGovernance.sol',
      source:     'return core.activePeerCount() / 3 + 1;',
      rationale:  'Admission gate — strictly more than one third of peers (the capture line).',
      compute:    (p) => `floor(${p} / 3) + 1 = ${Math.floor(p / 3)} + 1 = ${Math.floor(p / 3) + 1}`,
    };
    case 'revoke': return {
      formula:    'ceil(peers / 2)',
      fn:         'revokeThreshold()',
      file:       'PeerGovernance.sol',
      source:     'return (core.activePeerCount() + 1) / 2;',
      rationale:  'Revocation gate — strict majority.',
      compute:    (p) => `(${p} + 1) / 2 = ${Math.floor((p + 1) / 2)}`,
    };
    case 'retire': return {
      formula:    'ceil(2 × peers / 3)',
      fn:         'retireThreshold()',
      file:       'EvidenceConsensus.sol',
      source:     'return (activePeerCount * 2 + 2) / 3;',
      rationale:  'Strong supermajority — retiring canon taxonomy must be much harder than ratifying it (2/3 sits above the 1/3 capture line).',
      compute:    (p) => `(${p} × 2 + 2) / 3 = ${Math.floor((p * 2 + 2) / 3)}`,
    };
    case 'expel': return {
      formula:    'ceil(peers × 25%)',
      fn:         'expelThreshold()',
      file:       'EvidenceConsensus.sol',
      source:     'return (n * 25 + 99) / 100;',
      rationale:  'Early-expel gate — one quarter of peers rejecting is enough to kill a bad submission before its window.',
      compute:    (p) => `(${p} × 25 + 99) / 100 = ${Math.floor((p * 25 + 99) / 100)}`,
    };
    case 'canonize': {
      const pct = tier ? TIER_CANONIZE_PCT[tier] : null;
      return {
        formula:   tier ? `ceil(peers × ${pct}%)` : 'ceil(peers × tier_pct%)',
        fn:        `canonizeThreshold(tier${tier ? ` = ${tier}` : ''})`,
        file:      'EvidenceConsensus.sol',
        source:    `return (n * ${tier ? pct : 'pct'} + 99) / 100;  // tier 1: 60% · tier 2: 55% · tier 3: 51%`,
        rationale: 'Tier-weighted canonization gate — higher tiers (declassified / peer-reviewed) require a stronger majority.',
        compute:   (p) => tier ? `(${p} × ${pct} + 99) / 100 = ${Math.floor((p * pct + 99) / 100)}` : null,
      };
    }
    case 'deprecate': {
      const pct = tier ? TIER_DEPRECATE_PCT[tier] : null;
      return {
        formula:   tier ? `ceil(peers × ${pct}%)` : 'ceil(peers × tier_pct%)',
        fn:        `deprecateThreshold(tier${tier ? ` = ${tier}` : ''})`,
        file:      'EvidenceConsensus.sol',
        source:    `return (n * ${tier ? pct : 'pct'} + 99) / 100;  // tier 1: 65% · tier 2: 60% · tier 3: 55%`,
        rationale: 'Tier-weighted deprecation gate — higher tiers are harder to retire than they are to canonize.',
        compute:   (p) => tier ? `(${p} × ${pct} + 99) / 100 = ${Math.floor((p * pct + 99) / 100)}` : null,
      };
    }
    case 'bundle': {
      const pct = tier ? TIER_CANONIZE_PCT[tier] : null;
      return {
        formula:   `max(floor(peers / 2) + 1, ${tier ? `ceil(peers × ${pct}%)` : 'ceil(peers × tier_pct%)'})`,
        fn:        `bundleThreshold(tier${tier ? ` = ${tier}` : ''})`,
        file:      'EvidenceConsensus.sol',
        source:    'return max(taxonomyThreshold(), canonizeThreshold(tier));',
        rationale: 'Founding-bundle gate — at least a taxonomy majority AND at least the tier-weighted canonize bar, so founding evidence never canonizes on a cheaper vote than the normal review path.',
        compute:   (p) => {
          const tax = Math.floor(p / 2) + 1;
          if (!tier) return `max(floor(${p}/2) + 1 = ${tax}, ceil(${p} × tier_pct%))`;
          const can = Math.floor((p * pct + 99) / 100);
          return `max(${tax}, ${can}) = ${Math.max(tax, can)}`;
        },
      };
    }
    default: return null;
  }
}

export function getVoteLogDerivation(row) {
  if (!row || row.peer_handle !== 'Network') return null;
  const tier      = Number(row.evidence_tier ?? 0) || null;
  const bindingId = row.binding_id || null;
  const nodeHash  = row.node_hash || null;
  const eviTerm   = row.evidence_id_text || row.evidence_id || null;
  const txHash    = row.tx_hash || null;
  if (!txHash) return null;
  switch (row.verdict) {
    case 'canonized':
      // BindingCanonized.payload.approve_count is reused by the contract for
      // both paths: under review it's the approve tally; under the founding-
      // bundle path it's the node endorsements count (see EvidenceConsensus.sol
      // line 939 — `approveCount: endorsements` for the founding mint). So the
      // chain count is the authoritative canonization count regardless of path;
      // the label below names both for honesty.
      return bindingId ? {
        kind: 'canonized',
        outcomeLabel: 'Approved into the canon',
        question: 'How was this binding canonized?',
        chainCount: { events: ['BindingCanonized'], countField: 'approve_count', label: 'On-chain consensus count (approves / founding-bundle endorses)' },
        thresholdFn: (peers) => tier && peers ? canonizeThreshold(tier, peers) : null,
        thresholdLabel: 'Canonize threshold',
        thresholdDoc: thresholdDoc('canonize', tier),
        thresholdNote: 'Canonization happens via review approves OR via founding-bundle endorses on the parent taxonomy node — the chain reuses `approve_count` for both paths.',
        moment: { txHash, events: ['BindingCanonized'] },
        filterTerm: eviTerm,
      } : null;
    case 'expelled':
      return bindingId ? {
        kind: 'expelled',
        outcomeLabel: 'Expelled at review',
        question: 'How many peers rejected this binding?',
        chainCount: { events: ['BindingExpelled'], countField: 'reject_count', label: 'On-chain rejects' },
        thresholdFn: (peers) => peers ? expelThreshold(peers) : null,
        thresholdLabel: 'Expel threshold',
        thresholdDoc: thresholdDoc('expel'),
        moment: { txHash, events: ['BindingExpelled'] },
        filterTerm: eviTerm,
      } : null;
    case 'lapsed':
      if (row.phase === 'review' && bindingId) {
        return {
          kind: 'review-lapsed',
          outcomeLabel: 'Lapsed at review (no consensus)',
          question: 'Why did this binding lapse?',
          queries: [
            { table: 'attestations', label: 'Approves cast', filter: { binding_id: bindingId, phase: 'review', verdict: 'approve' } },
            { table: 'attestations', label: 'Rejects cast', filter: { binding_id: bindingId, phase: 'review', verdict: 'reject' } },
          ],
          thresholdFn: (peers) => tier && peers ? canonizeThreshold(tier, peers) : null,
          thresholdLabel: 'Canonize threshold (not reached)',
          thresholdDoc: thresholdDoc('canonize', tier),
          moment: { txHash, events: ['BindingLapsed'] },
          filterTerm: eviTerm,
        };
      }
      if (row.phase === 'taxonomy' && nodeHash) {
        return {
          kind: 'taxonomy-lapsed',
          outcomeLabel: 'Proposal lapsed (no ratification)',
          question: 'How many peers endorsed before the window closed?',
          query: { table: 'attestations', label: 'Endorses cast', filter: { node_hash: nodeHash, phase: 'taxonomy', verdict: 'endorse' } },
          thresholdFn: (peers) => tier && peers ? bundleThreshold(tier, peers) : null,
          thresholdLabel: 'Bundle threshold (not reached)',
          thresholdDoc: thresholdDoc('bundle', tier),
          moment: { txHash, events: ['ProposalLapsed'] },
          filterTerm: row.topic_id || row.pillar_id || nodeHash,
        };
      }
      return null;
    case 'deprecated':
      return bindingId ? {
        kind: 'deprecated',
        outcomeLabel: 'Deprecated at challenge',
        question: 'How many peers voted to deprecate?',
        chainCount: { events: ['BindingDeprecated'], countField: 'challenge_votes', label: 'On-chain deprecate votes' },
        thresholdFn: (peers) => tier && peers ? deprecateThreshold(tier, peers) : null,
        thresholdLabel: 'Deprecate threshold',
        thresholdDoc: thresholdDoc('deprecate', tier),
        moment: { txHash, events: ['BindingDeprecated'] },
        filterTerm: eviTerm,
      } : null;
    case 'reaffirmed':
      // chainCount holds defend votes (the side that won). Keep only the
      // challenge-side off-chain count so the panel shows the failed attack tally.
      return bindingId ? {
        kind: 'reaffirmed',
        outcomeLabel: 'Reaffirmed against the challenge',
        question: 'Why did the challenge fail?',
        query: { table: 'attestations', label: 'Challenge votes (failed)', filter: { binding_id: bindingId, phase: 'challenge', verdict: 'challenge' } },
        chainCount: { events: ['BindingReaffirmed'], countField: 'defense_votes', label: 'On-chain defend votes' },
        thresholdFn: (peers) => tier && peers ? deprecateThreshold(tier, peers) : null,
        thresholdLabel: 'Deprecate threshold (not reached)',
        thresholdDoc: thresholdDoc('deprecate', tier),
        moment: { txHash, events: ['BindingReaffirmed'] },
        filterTerm: eviTerm,
      } : null;
    case 'ratified':
      // PillarRatified / TopicRatified themselves carry no count; but their
      // sibling NodeEndorsed in the same tx (the threshold-crossing endorse
      // that triggered ratification) has the authoritative count + threshold
      // straight from the contract. For a BUNDLED topic the NodeEndorsed is
      // for the parent pillar's node_hash — that's still the right count
      // since the bundle ratifies on one shared endorsement gate.
      return nodeHash ? {
        kind: 'ratified',
        outcomeLabel: 'Ratified into the taxonomy',
        question: 'How many peers endorsed this proposal?',
        chainCount: { events: ['NodeEndorsed'], countField: 'endorsements', thresholdField: 'threshold', label: 'On-chain endorsements' },
        thresholdLabel: 'Bundle threshold',
        // Founding-evidence tier isn't on the row (the chain event has no
        // evidence_id), so we show the generic bundle formula with the tier
        // table; the actual value above comes from the chain payload anyway.
        thresholdDoc: thresholdDoc('bundle', null),
        moment: { txHash, events: ['PillarRatified', 'TopicRatified'] },
        // Slug-based linkback so the log search lands on rows whose pillar /
        // topic title matches — node_hash hex isn't surfaced in the log.
        filterTerm: row.topic_id || row.pillar_id || nodeHash,
      } : null;
    case 'retired':
      // NodeRetireVoteCast carries votes + threshold in the same tx that emits
      // NodeRetired; read it instead of recomputing from formulas.
      return nodeHash ? {
        kind: 'retired',
        outcomeLabel: 'Retired off the canon',
        question: 'How many peers voted to retire?',
        chainCount: { events: ['NodeRetireVoteCast'], countField: 'votes', thresholdField: 'threshold', label: 'On-chain retire votes' },
        thresholdLabel: 'Retire threshold',
        thresholdDoc: thresholdDoc('retire'),
        moment: { txHash, events: ['NodeRetired'] },
        filterTerm: row.topic_id || row.pillar_id || nodeHash,
      } : null;
    default:
      return null;
  }
}

export function getRegistryDerivation(row) {
  if (!row) return null;
  const subject = (row.subjectAddr || '').toLowerCase();
  if (!subject) return null;
  // Registry-log rows already carry block_number + the raw event payload from
  // normalizeRegistryEvent — peer-set mutation events (NomineeVerified /
  // PeerRevoked) include active_peer_count directly, so the moment-peers
  // resolution is instant; RevocationCancelled has no count in payload and
  // falls back to a block-number lookup.
  const moment = {
    txHash:      row.txHash ?? null,
    blockNumber: row.blockNumber ?? null,
    payload:     row.payload ?? null,
  };
  // Nominee verification and revocation BOTH fire their sibling vote event
  // (PeerEndorsed / RevocationVoteCast) in the same tx that triggers the
  // outcome. Those vote events carry the FINAL count + threshold in their
  // payload — the contract's own truth at that block. Reading them via
  // chainCount avoids two real risks:
  //   • the off-chain `nominee_votes` / `revocation_votes` mirror can have
  //     gaps (the edge fn writes them best-effort; the chain is authoritative);
  //   • the live peer count has shifted since, so recomputing the threshold
  //     from peers-now would lie about what the contract required.
  // The off-chain row count is still shown alongside, labelled as the
  // independently-verifiable signature mirror.
  // (Per PeerGovernance.sol: the nominator is NOT counted as endorsement #1 —
  // nomineeEndorsements starts at 0 and only PeerEndorsed events increment it.)
  switch (row.action) {
    case 'verified':
      return {
        kind: 'verified',
        outcomeLabel: 'Verified as a peer',
        question: 'How many peers endorsed this nominee?',
        chainCount: { events: ['PeerEndorsed'], countField: 'endorsements', thresholdField: 'threshold', label: 'On-chain endorsements' },
        thresholdFn: (peers) => peers != null ? NOMINEE_THRESHOLD(peers) : null,
        thresholdLabel: 'Nominee threshold',
        thresholdDoc: thresholdDoc('nominee'),
        // NomineeVerified.payload.active_peer_count is the POST-add value;
        // the threshold check inside the same tx used the PRE-add count.
        moment: { ...moment, peersAdjust: -1 },
        filterTerm: subject,
      };
    case 'revoked':
      return {
        kind: 'revoked',
        outcomeLabel: 'Revoked from the peer set',
        question: 'How many peers voted to discard?',
        chainCount: { events: ['RevocationVoteCast'], countField: 'votes', thresholdField: 'threshold', label: 'On-chain discard votes' },
        thresholdFn: (peers) => peers != null ? REVOKE_THRESHOLD(peers) : null,
        thresholdLabel: 'Revoke threshold',
        thresholdDoc: thresholdDoc('revoke'),
        // PeerRevoked.payload.active_peer_count is POST-removal; the threshold
        // check inside the same tx used the PRE-removal count.
        moment: { ...moment, peersAdjust: 1 },
        filterTerm: subject,
      };
    // 'cancelled' is NOT a derivable consensus outcome: RevocationCancelled
    // fires from `cancelStaleRevocation`, a permissionless GC after the revoke
    // window expires WITHOUT discards reaching threshold. Keep votes have no
    // on-chain effect — they're an off-chain attestation surface only. So this
    // row stays "On-chain ✓" (timeout-GC, no tally to derive), same treatment
    // as NomineeLapsed and Inactivity.
    default:
      return null;
  }
}

// One supabase head-count per query in the descriptor. Returns an array of
// { label, count } so the panel can render multi-side tallies (lapsed,
// reaffirmed) uniformly with single-side ones (canonized, revoked, ...).
export async function fetchDerivationTally(descriptor) {
  if (!descriptor) return null;
  const queries = descriptor.queries || (descriptor.query ? [descriptor.query] : []);
  const out = [];
  for (const q of queries) {
    if (!q?.table) continue;
    let req = supabase.from(q.table).select('*', { count: 'exact', head: true });
    for (const [k, v] of Object.entries(q.filter || {})) req = req.eq(k, v);
    const { count, error } = await req;
    out.push({ label: q.label || 'Signed peers', count: error ? null : (count ?? 0), error: error?.message || null });
  }
  return out;
}

// Read the contract-authoritative count + threshold from the sibling vote
// event the consensus tx emitted (PeerEndorsed for nominee verify,
// RevocationVoteCast for revoke, BindingCanonized's own payload for canonize,
// etc.). The chain payload is the source of truth at the moment — the
// off-chain mirror tables can have write gaps, and the live peer count has
// shifted since, so neither of those is a safe substitute.
//
// Picks the highest-log_index match in the tx so the LAST vote in a sequence
// (the threshold-crossing one) is what we read.
export async function fetchChainCount(descriptor) {
  if (!descriptor?.chainCount?.events?.length || !descriptor.moment?.txHash) return null;
  const { data } = await supabase
    .from('chain_events')
    .select('event_name, payload, log_index')
    .eq('tx_hash', descriptor.moment.txHash)
    .in('event_name', descriptor.chainCount.events)
    .order('log_index', { ascending: false })
    .limit(1);
  const row = data?.[0];
  if (!row) return null;
  const cf = descriptor.chainCount.countField;
  const tf = descriptor.chainCount.thresholdField;
  return {
    count:     cf && row.payload?.[cf] != null ? Number(row.payload[cf]) : null,
    threshold: tf && row.payload?.[tf] != null ? Number(row.payload[tf]) : null,
    eventName: row.event_name,
    label:     descriptor.chainCount.label || 'On-chain count',
  };
}

// Find a chain_events row by tx hash + one of the candidate event_name values.
// Used by the DerivationPanel to recover the moment of a vote_log_view Network
// row (which exposes tx_hash but not block_number or payload).
export async function fetchNetworkEventByTx(txHash, eventNames) {
  if (!txHash || !eventNames?.length) return null;
  const { data } = await supabase
    .from('chain_events')
    .select('block_number, log_index, event_name, payload')
    .eq('tx_hash', txHash)
    .in('event_name', eventNames)
    .order('log_index', { ascending: false })
    .limit(1);
  return (data && data[0]) || null;
}

// active_peer_count "at the time" of `blockNumber` — i.e. the value emitted by
// the most recent peer-set mutation (PeerAdded / PeerRemoved) at or before that
// block. Mirrors the chain's own activePeerCount() reading at that point in
// history, without needing an archive RPC.
export async function peerCountAtBlock(blockNumber) {
  if (blockNumber == null) return null;
  const { data } = await supabase
    .from('chain_events')
    .select('payload, block_number, log_index')
    .in('event_name', ['PeerAdded', 'PeerRemoved'])
    .lte('block_number', blockNumber)
    .order('block_number', { ascending: false })
    .order('log_index',    { ascending: false })
    .limit(1);
  const p = data?.[0]?.payload || null;
  return p?.active_peer_count ?? null;
}

// ── Per-evidence vote history hook ───────────────────────────────────────────
//
// Every signed peer vote on one piece of evidence (across all its topic
// bindings), newest first. Reads the public `attestation_log_view` so the
// archive can show "who voted" to anyone, no wallet required. Keyed by evidence
// id and refetched whenever it changes.
export function useEvidenceVotes(evidenceId) {
  const [votes, setVotes]     = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!evidenceId) { setVotes([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    supabase
      .from('attestation_log_view')
      .select('*')
      .eq('evidence_id', evidenceId)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (cancelled) return;
        setVotes(data || []);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [evidenceId]);

  return { votes, loading };
}

// ── Peer registry voting log ─────────────────────────────────────────────────
//
// The registry analogue of the evidence vote history (useAttestationLog): every
// governance vote and lifecycle event on the named peer set — nominee
// endorsements, revocation discard votes, and the motions/outcomes that bracket
// them — as one searchable, paginated stream, newest first. On-chain acts come
// from `chain_events`; the off-chain signed "keep" dissents (which have no
// on-chain call) are merged in from `revocation_votes`. Searchable by subject or
// actor address, handle, or tx hash; `kind` narrows to a vote class
// (endorse · discard · keep).
const REGISTRY_PAGE = 30;
// Vote-class → the chain events that make up that class. "Endorse" folds in the
// nomination (the nominator's founding endorsement); "discard" folds in the
// motion (the act that opens the discard vote). The keep class has no chain
// event — it lives purely in revocation_votes.
const REGISTRY_KIND_EVENTS = {
  endorse: ['PeerNominated', 'PeerEndorsed'],
  discard: ['RevocationMotioned', 'RevocationVoteCast'],
};
// The full registry stream (unfiltered): votes + the lifecycle outcomes that
// resolve them, so the log reads as a complete record of the peer set's history.
const REGISTRY_ALL_EVENTS = [
  'PeerNominated', 'PeerEndorsed', 'NomineeVerified', 'NomineeLapsed',
  'RevocationMotioned', 'RevocationVoteCast', 'RevocationCancelled',
  'PeerRevoked', 'PeerAdded', 'PeerRemoved',
];

// chain_events row → normalized registry-log row. `subjectAddr` is the peer the
// action concerns (the nominee / the peer under revocation); `actorAddr` is who
// cast it (endorser / voter / nominator / motioner), null for network outcomes.
function normalizeRegistryEvent(r) {
  const p  = r.payload || {};
  const ts = r.occurred_at || r.inserted_at;
  // payload + blockNumber are preserved verbatim so the DerivationPanel can
  // read the moment-in-time active_peer_count (PeerAdded / PeerRemoved /
  // NomineeVerified / PeerRevoked all carry it) instead of recomputing the
  // threshold from the *current* peer count.
  const base = { id: `ev:${r.id}`, ts, source: 'chain', txHash: r.tx_hash, blockNumber: r.block_number ?? null, payload: p, subjectAddr: r.peer_addr || null, subjectHandle: null, actorAddr: null, count: null, threshold: null };
  switch (r.event_name) {
    case 'PeerNominated':       return { ...base, action: 'nominate',  actorAddr: p.nominated_by || null, subjectHandle: p.handle || null, count: 1, threshold: p.threshold ?? null };
    case 'PeerEndorsed':        return { ...base, action: 'endorse',   actorAddr: p.endorser || null, count: p.endorsements ?? null, threshold: p.threshold ?? null };
    case 'NomineeVerified':     return { ...base, action: 'verified',  subjectHandle: p.handle || null };
    case 'NomineeLapsed':       return { ...base, action: 'lapsed' };
    case 'RevocationMotioned':  return { ...base, action: 'motion',    actorAddr: p.by || null, threshold: p.threshold ?? null };
    case 'RevocationVoteCast':  return { ...base, action: 'discard',   actorAddr: p.voter || null, count: p.votes ?? null, threshold: p.threshold ?? null };
    case 'RevocationCancelled': return { ...base, action: 'cancelled' };
    case 'PeerRevoked':         return { ...base, action: 'revoked' };
    case 'PeerAdded':           return { ...base, action: 'seeded',    subjectHandle: p.handle || null };
    case 'PeerRemoved':         return { ...base, action: 'removed' };
    default:                    return { ...base, action: r.event_name };
  }
}

export function usePeerRegistryLog(pageSize = REGISTRY_PAGE, query = '', kind = '') {
  const [chain, setChain]     = useState([]);
  const [keeps, setKeeps]     = useState([]);
  const [page, setPage]       = useState(0);
  const [chainCount, setChainCount] = useState(null);
  const [loading, setLoading] = useState(true);

  // Same sanitize + per-term AND-of-ORs search semantics as useAttestationLog.
  const terms = query.trim().replace(/[,()*"%\\]/g, '').split(/\s+/).filter(Boolean);
  const termsKey = terms.join(' ');
  const k = ['endorse', 'discard', 'keep'].includes(kind) ? kind : '';
  const events = k === 'keep' ? [] : (REGISTRY_KIND_EVENTS[k] || REGISTRY_ALL_EVENTS);
  const eventsKey = events.join(',');
  const includeKeeps = k === '' || k === 'keep';

  // Search across the subject (peer_addr), every actor address carried in the
  // jsonb payload, the snapshotted handle, and the tx hash. PostgREST supports
  // json arrow operators inside or(), so a single per-term OR covers them all.
  const applyChain = (req) => {
    req = req.in('event_name', events);
    for (const t of terms) {
      req = req.or(
        `peer_addr.ilike.%${t}%,tx_hash.ilike.%${t}%,payload->>endorser.ilike.%${t}%,payload->>voter.ilike.%${t}%,payload->>nominated_by.ilike.%${t}%,payload->>by.ilike.%${t}%,payload->>handle.ilike.%${t}%`,
      );
    }
    return req;
  };

  const fetchChainPage = (pageIdx) => {
    if (!events.length) return Promise.resolve({ data: [], count: 0 });
    return applyChain(
      supabase
        .from('chain_events')
        .select('*', { count: 'estimated' })
        .order('block_number', { ascending: false })
        .order('log_index', { ascending: false }),
    ).range(pageIdx * pageSize, pageIdx * pageSize + pageSize - 1);
  };

  // Keeps are low-cardinality (bounded by peers × revocation rounds), so the
  // matching set is loaded in one shot rather than paginated.
  const fetchKeeps = () => {
    if (!includeKeeps) return Promise.resolve({ data: [] });
    let req = supabase
      .from('revocation_votes')
      .select('*')
      .eq('verdict', 'keep')
      .order('created_at', { ascending: false })
      .limit(500);
    for (const t of terms) req = req.or(`subject_addr.ilike.%${t}%,voter_addr.ilike.%${t}%`);
    return req;
  };

  const normalizeKeep = (kp) => ({
    id: `keep:${kp.id}`, ts: kp.created_at, source: 'offchain', action: 'keep',
    subjectAddr: kp.subject_addr, subjectHandle: null, actorAddr: kp.voter_addr,
    sig: kp.eip712_sig, round: kp.round, note: kp.note, count: null, threshold: null,
  });

  // The on-chain vote events carry no note (the note text lives off-chain), so
  // attach each endorse/discard/motion row's deliberation note + signature from
  // its off-chain record (nominee_votes / revocation_votes), joined by
  // (subject, actor). A peer votes once per round, so the latest match wins.
  const attachNotes = async (rows) => {
    const endorseRows  = rows.filter(r => r.action === 'endorse' && r.subjectAddr && r.actorAddr);
    const nominateRows = rows.filter(r => r.action === 'nominate' && r.subjectAddr && r.actorAddr);
    const discardRows  = rows.filter(r => (r.action === 'discard' || r.action === 'motion') && r.subjectAddr && r.actorAddr);
    const map = {};
    if (endorseRows.length) {
      const { data } = await supabase
        .from('nominee_votes')
        .select('nominee_addr, voter_addr, note, eip712_sig, round, created_at')
        .eq('verdict', 'endorse')
        .in('nominee_addr', [...new Set(endorseRows.map(r => r.subjectAddr.toLowerCase()))])
        .in('voter_addr',   [...new Set(endorseRows.map(r => r.actorAddr.toLowerCase()))])
        .order('created_at', { ascending: false });
      for (const n of data || []) {
        const key = `n:${n.nominee_addr}:${n.voter_addr}`;
        if (!(key in map)) map[key] = { note: n.note, sig: n.eip712_sig, round: n.round };
      }
    }
    if (nominateRows.length) {
      const { data } = await supabase
        .from('nominee_votes')
        .select('nominee_addr, voter_addr, note, eip712_sig, round, created_at')
        .eq('verdict', 'nominate')
        .in('nominee_addr', [...new Set(nominateRows.map(r => r.subjectAddr.toLowerCase()))])
        .in('voter_addr',   [...new Set(nominateRows.map(r => r.actorAddr.toLowerCase()))])
        .order('created_at', { ascending: false });
      for (const n of data || []) {
        const key = `nm:${n.nominee_addr}:${n.voter_addr}`;
        if (!(key in map)) map[key] = { note: n.note, sig: n.eip712_sig, round: n.round };
      }
    }
    if (discardRows.length) {
      const { data } = await supabase
        .from('revocation_votes')
        .select('subject_addr, voter_addr, note, eip712_sig, round, created_at')
        .eq('verdict', 'discard')
        .in('subject_addr', [...new Set(discardRows.map(r => r.subjectAddr.toLowerCase()))])
        .in('voter_addr',   [...new Set(discardRows.map(r => r.actorAddr.toLowerCase()))])
        .order('created_at', { ascending: false });
      for (const d of data || []) {
        const key = `d:${d.subject_addr}:${d.voter_addr}`;
        if (!(key in map)) map[key] = { note: d.note, sig: d.eip712_sig, round: d.round };
      }
    }
    return rows.map(r => {
      const key = r.action === 'endorse' && r.subjectAddr && r.actorAddr
        ? `n:${r.subjectAddr.toLowerCase()}:${r.actorAddr.toLowerCase()}`
        : r.action === 'nominate' && r.subjectAddr && r.actorAddr
          ? `nm:${r.subjectAddr.toLowerCase()}:${r.actorAddr.toLowerCase()}`
        : (r.action === 'discard' || r.action === 'motion') && r.subjectAddr && r.actorAddr
          ? `d:${r.subjectAddr.toLowerCase()}:${r.actorAddr.toLowerCase()}`
          : null;
      const hit = key ? map[key] : null;
      return hit ? { ...r, note: hit.note, sig: hit.sig, round: hit.round } : r;
    });
  };

  const loadChainRows = async (pageIdx) => {
    const { data, count } = await fetchChainPage(pageIdx);
    const rows = await attachNotes((data || []).map(normalizeRegistryEvent));
    return { rows, count };
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setPage(0); setChainCount(null);
    Promise.all([loadChainRows(0), fetchKeeps()]).then(([c, kp]) => {
      if (cancelled) return;
      setChain(c.rows);
      setKeeps((kp.data || []).map(normalizeKeep));
      setChainCount(c.count ?? null);
      setLoading(false);
    });
    return () => { cancelled = true; };
  // applyChain/fetchKeeps close over terms/k; pageSize is a dep too.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize, termsKey, k, eventsKey]);

  const loadMore = () => {
    const next = page + 1;
    setPage(next);
    setLoading(true);
    loadChainRows(next).then(({ rows }) => {
      setChain(prev => [...prev, ...rows]);
      setLoading(false);
    });
  };

  const hasMore = chainCount === null
    ? chain.length === (page + 1) * pageSize
    : chain.length < chainCount;

  // Hold keeps behind the chain-pagination frontier so they don't leak past the
  // loaded on-chain window; once the chain stream is exhausted, show them all.
  const frontier = hasMore && chain.length ? chain[chain.length - 1].ts : null;
  const shownKeeps = frontier ? keeps.filter(x => x.ts && x.ts >= frontier) : keeps;
  // Two contract-side foldings keep "consensus + downstream peer-set mutation"
  // tx-pairs from showing as two rows:
  //   • Nominee graduation: _checkNominee calls gAddPeer then emits NomineeVerified
  //     → suppress the PeerAdded twin; show one "Verified" row.
  //   • Successful revocation: voteRevoke calls gRemovePeer then emits PeerRevoked
  //     → suppress the PeerRemoved twin; show one "Revoked" row.
  // Owner-seeded peers still surface as "Seeded" (no NomineeVerified twin);
  // orphan PeerRemoved rows (no PeerRevoked twin) are inactivity-prune outcomes
  // and are relabelled "Inactivity" so the action is read at a glance.
  const verifiedTx = new Set(chain.filter(r => r.action === 'verified' && r.txHash).map(r => r.txHash));
  const revokedTx  = new Set(chain.filter(r => r.action === 'revoked'  && r.txHash).map(r => r.txHash));
  const chainShown = chain
    .filter(r => {
      if (r.action === 'seeded'  && r.txHash && verifiedTx.has(r.txHash)) return false;
      if (r.action === 'removed' && r.txHash && revokedTx.has(r.txHash))  return false;
      return true;
    })
    .map(r => r.action === 'removed' ? { ...r, action: 'inactivity' } : r);
  const log = [...chainShown, ...shownKeeps].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const total = chainCount === null ? null : chainCount + keeps.length - (chain.length - chainShown.length);

  return { log, loading, hasMore, loadMore, total };
}

// ── Reviews-signed count hook ────────────────────────────────────────────────
//
// Lifetime count of attestations signed by a given peer address. Unlike the
// in-session vote tally, this survives evidence leaving the pending queue.
export function useMyReviewCount(addr) {
  const [count, setCount] = useState(null);

  useEffect(() => {
    if (!addr) { setCount(null); return; }
    let cancelled = false;
    supabase
      .from('attestations')
      .select('*', { count: 'exact', head: true })
      .eq('peer_addr', addr)
      .then(({ count: c }) => { if (!cancelled) setCount(c ?? 0); });
    return () => { cancelled = true; };
  }, [addr]);

  return count;
}

// ── Retry helper ─────────────────────────────────────────────────────────────
//
// Retries a Supabase query up to `retries` times with linear back-off.
// `fn` must return a Supabase response object ({ data, error }).
// Throws if every attempt returns an error.
//
async function withRetry(fn, retries = 3, delayMs = 800) {
  let result;
  for (let i = 0; i < retries; i++) {
    result = await fn();
    if (!result.error) return result;
    if (i < retries - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  throw result.error;
}

// ── Attestation write via edge function ──────────────────────────────────────
//
// All attestation inserts/upserts go through the verify-attestation edge
// function rather than directly to PostgREST.  The edge function:
//   1. Verifies the EIP-712 signature (when present) before writing.
//   2. Writes with the service role, bypassing RLS.
// Direct anon INSERT/UPDATE on the attestations table is blocked by RLS.
//
async function insertAttestation(payload) {
  const { data, error } = await supabase.functions.invoke('verify-attestation', { body: payload });
  if (error) return { error };
  if (data?.error) return { error: new Error(String(data.error)) };
  return { data };
}

// ── Vote: approve or reject a pending submission ─────────────────────────────
//
// Upserts the peer's attestation (with retry), recounts from DB to avoid
// races, then flips evidence.status if a threshold is met.
//
// txHash — confirmed on-chain transaction hash (null in dev mode / no contract)
// peerCount — live active-peer count from the contract (falls back to
//             ACTIVE_PEER_COUNT when not provided)
//
// `sig` is now the EIP-712 **Vote** signature the chain recovered (or a
// dev-mode signVoteOnly() signature) — not the old Attestation signature. The
// trailing `vote` object carries the rest of what the chain bound the signature
// to so verify-attestation can recover the same Vote digest server-side:
//   round       — the binding's review round at signing time (anti-replay)
//   noteHash    — keccak256 of the deliberation note (ZeroHash when empty)
//   bindingHash — the on-chain bindingId (keccak256(abi.encode(id, topicId)))
export async function castReviewVote(binding, verdict, peerAddr, peerHandle, note, sig, txHash = null, peerCount, vote = {}) {
  const result = await withRetry(() => insertAttestation({
    evidence_id: binding.id, topic_id: binding.topicId, binding_id: binding.bindingId,
    peer_addr: peerAddr, peer_handle: peerHandle,
    phase: 'review', verdict, note: note || null,
    eip712_sig: sig || null, tx_hash: txHash || null,
    round: vote.round ?? null, note_hash: vote.noteHash ?? null, binding_hash: vote.bindingHash ?? null,
    action: 'review_vote',
  }));
  return {
    approvals:  result.data?.approve_count ?? 0,
    rejections: result.data?.reject_count  ?? 0,
  };
}

// ── Taxonomy endorsement: a signed vote on a proposed pillar/topic bundle ────
//
// Endorsing a taxonomy node is the same accountable, signed act as a review
// vote, so it is recorded as a first-class attestation (phase 'taxonomy',
// verdict 'endorse') and surfaced in the Vote history.  The on-chain
// `endorseNode` is the real consensus gate; this writes the off-chain signed
// record after it confirms.  The attestation is tied to the proposal's FOUNDING
// binding (every proposal ships one), so it joins the attestation log by
// binding_id with no schema gymnastics.
//
//   nodeHash   — the endorsed node's on-chain id (pillar hash for a pillar
//                bundle; topic hash for a topic bundle); verified against the
//                NodeEndorsed event in `txHash`.
//   evidenceId — the founding evidence uuid (signed in the EIP-712 message)
//   topicId    — the founding topic slug (signed in the EIP-712 message)
//   bindingId  — the founding binding uuid (the attestation row's target)
//
export async function endorseNodeSupabase({ nodeHash, evidenceId, topicId, bindingId, peerAddr, peerHandle, note, sig, txHash = null, round = null, noteHash = null }) {
  await withRetry(() => insertAttestation({
    evidence_id: evidenceId, topic_id: topicId, binding_id: bindingId,
    node_hash: nodeHash,
    peer_addr: peerAddr, peer_handle: peerHandle,
    phase: 'taxonomy', verdict: 'endorse', note: note || null,
    eip712_sig: sig || null, tx_hash: txHash || null,
    // Vote-reconstruction surface: the on-chain endorse signs a Vote(phase 2,
    // bindingId = node_hash, round, noteHash). Sent so verify-attestation can
    // recover the SAME Vote. Absent in dev mode (legacy Attestation fallback).
    round: round ?? null, note_hash: noteHash ?? null,
    action: 'endorse_node',
  }));
}

// ── Taxonomy rejection: a signed vote AGAINST a proposed pillar/topic bundle ──
//
// The contract has no on-chain "reject node" — a node ratifies at threshold
// endorsements and otherwise lapses at the proposal window. So a rejection is a
// first-class, EIP-712-signed dissent recorded purely off-chain (phase
// 'taxonomy', verdict 'reject', NO tx_hash). It carries no on-chain weight and
// the vote-counter trigger ignores taxonomy rows, so it never touches the
// founding binding's tallies — but it gives a peer a definite position on every
// proposal (so the peer-review gate can clear) and puts that dissent, with its
// deliberation note, on the public record next to the endorsements.
//
// Like an endorsement it targets the proposal's FOUNDING binding, so a peer has
// at most one taxonomy attestation per proposal (unique binding_id+peer+phase):
// a later endorseNode upsert simply overwrites a prior reject.
export async function rejectNodeSupabase({ nodeHash, evidenceId, topicId, bindingId, peerAddr, peerHandle, note, sig }) {
  await withRetry(() => insertAttestation({
    evidence_id: evidenceId, topic_id: topicId, binding_id: bindingId,
    node_hash: nodeHash,
    peer_addr: peerAddr, peer_handle: peerHandle,
    phase: 'taxonomy', verdict: 'reject', note: note || null,
    eip712_sig: sig || null, tx_hash: null,
    action: 'reject_node',
  }));
}

// This peer's off-chain taxonomy rejections, as a Set of founding binding ids.
// Endorsements are read on-chain (hasEndorsedNode); rejections live only here,
// so the taxonomy gate combines both to know which proposals a peer has acted on.
export async function fetchMyTaxonomyRejects(peerAddr) {
  if (!peerAddr) return new Set();
  const { data } = await supabase
    .from('attestations')
    .select('binding_id')
    .eq('peer_addr', peerAddr.toLowerCase())
    .eq('phase', 'taxonomy')
    .eq('verdict', 'reject');
  return new Set((data || []).map(r => r.binding_id).filter(Boolean));
}

// Off-chain reject count per founding binding — used to hide proposals from the
// vote queue once dissent makes ratification mathematically impossible (the
// contract has no on-chain reject, so the proposal sits Proposed until the
// 30-day window lapses, but the UI shouldn't keep soliciting votes on a dead
// one). Each peer has at most one taxonomy attestation per founding binding
// (a later endorseNode upserts over a prior reject), so a row count is the
// current dissent count.
export async function fetchTaxonomyDissentCounts(bindingIds) {
  if (!bindingIds || bindingIds.length === 0) return new Map();
  const { data } = await supabase
    .from('attestations')
    .select('binding_id')
    .in('binding_id', bindingIds)
    .eq('phase', 'taxonomy')
    .eq('verdict', 'reject');
  const m = new Map();
  for (const r of data || []) m.set(r.binding_id, (m.get(r.binding_id) || 0) + 1);
  return m;
}

// ── Peer revocation: off-chain signed "keep" position ────────────────────────
//
// The contract has no on-chain keep — only voteRevoke (discard, ceil(n/2) to
// remove). A keep is a first-class EIP-712-signed dissent written off-chain via
// the revocation-vote edge function (mirrors the taxonomy reject) and read by
// the peer-review batch gate, so the network has to take a position on every
// open revocation. Bound to the on-chain revokeRound, so a re-motion resets it.
export async function castRevocationKeep({ subjectAddr, voterAddr, round, note, sig }) {
  const { data, error } = await supabase.functions.invoke('revocation-vote', {
    body: { subject_addr: subjectAddr, peer_addr: voterAddr, round, verdict: 'keep', note: note || null, eip712_sig: sig },
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  return data;
}

// Record the off-chain NOTE for a discard vote (motion / voteRevoke). The discard
// itself is cast + EIP-712-verified on-chain; this persists the deliberation note
// + the same PeerVote signature the chain recovered, gated on `hasVotedRevoke`.
// Best-effort: the on-chain vote stands even if this note write fails.
export async function castRevocationDiscard({ subjectAddr, voterAddr, round, note, sig }) {
  const { data, error } = await supabase.functions.invoke('revocation-vote', {
    body: { subject_addr: subjectAddr, peer_addr: voterAddr, round, verdict: 'discard', note: note || null, eip712_sig: sig },
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  return data;
}

// ── Nominee endorsement: off-chain signed note ───────────────────────────────
//
// The endorsement is cast + EIP-712-verified on-chain (PeerGovernance recovers
// the voter from a PeerVote); this records its deliberation note + the same
// signature via the nominee-vote edge function, gated on `hasEndorsed`. Mirrors
// castRevocationDiscard. Best-effort — the on-chain endorsement stands regardless.
export async function castNomineeEndorse({ nomineeAddr, voterAddr, round, note, sig }) {
  const { data, error } = await supabase.functions.invoke('nominee-vote', {
    body: { nominee_addr: nomineeAddr, peer_addr: voterAddr, round, note: note || null, eip712_sig: sig },
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  return data;
}

// ── Nominate: off-chain signed note for the NOMINATOR's own act ───────────────
//
// Nominating a peer is now an EIP-712 PeerVote (kind 2) recovered on-chain by
// PeerGovernance. This records the nominator's deliberation note + the same
// signature via the nominee-vote edge function (verdict 'nominate', gated on
// gov.nomineeBy == voter). Best-effort — the on-chain nomination stands.
export async function castNominate({ nomineeAddr, nominatorAddr, round, note, sig }) {
  const { data, error } = await supabase.functions.invoke('nominee-vote', {
    body: { nominee_addr: nomineeAddr, peer_addr: nominatorAddr, round, verdict: 'nominate', note: note || null, eip712_sig: sig },
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  return data;
}

// ── Governance note: off-chain note for a node/owner-scoped vote ─────────────
//
// Taxonomy RETIRE (motion/vote) and FORCE-RENOUNCE (motion/vote) are on-chain
// EIP-712 `Vote`-signed; this records the deliberation note + the SAME signature
// the chain recovered via the `gov-note` edge function (which re-verifies the
// Vote and the matching on-chain event), so they surface in the shared vote
// history. Best-effort — the on-chain vote stands regardless.
//   kind: 'retire' | 'force_renounce'   verdict: 'retire' | 'renounce'
//   subject: on-chain Vote bindingId (node id for retire; the sentinel for force-renounce)
export async function castGovNote({ kind, subject, topicId = null, verdict, round, note, noteHash, sig, txHash = null, peerAddr, peerHandle = null }) {
  const { data, error } = await supabase.functions.invoke('gov-note', {
    body: { kind, subject, topic_id: topicId, verdict, round, note: note || null, note_hash: noteHash || null, eip712_sig: sig, tx_hash: txHash, peer_addr: peerAddr, peer_handle: peerHandle },
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  return data;
}

// This voter's keep positions, as a Set of `${subjectAddrLower}:${round}` — so a
// keep only counts for the round it was cast in (a re-motion bumps the round).
export async function fetchMyRevocationKeeps(voterAddr) {
  if (!voterAddr) return new Set();
  const { data } = await supabase
    .from('revocation_votes')
    .select('subject_addr, round')
    .eq('voter_addr', voterAddr.toLowerCase())
    .eq('verdict', 'keep');
  return new Set((data || []).map(r => `${r.subject_addr}:${r.round}`));
}

// Keep-vote counts for the CURRENT round of each open revocation.
// `rounds` maps subjectAddrLower → round; returns subjectAddrLower → count.
export async function fetchRevocationKeepCounts(rounds) {
  const subjects = Object.keys(rounds || {});
  if (!subjects.length) return {};
  const { data } = await supabase
    .from('revocation_votes')
    .select('subject_addr, round')
    .in('subject_addr', subjects)
    .eq('verdict', 'keep');
  const counts = {};
  for (const r of data || []) {
    if (r.round === rounds[r.subject_addr]) counts[r.subject_addr] = (counts[r.subject_addr] || 0) + 1;
  }
  return counts;
}

// ── Register an (evidence × topic) binding on-chain ──────────────────────────
//
// After submitEvidence / fileBinding confirms, the edge function verifies the
// tx contains the matching BindingSubmitted event and flips submitted_onchain.
export async function markBindingOnchain(binding, peerAddr, txHash) {
  await withRetry(() => insertAttestation({
    evidence_id: binding.id, topic_id: binding.topicId, binding_id: binding.bindingId,
    peer_addr: peerAddr,
    tx_hash: txHash,
    action: 'register_binding_onchain',
  }));
}

// ── Challenge: open a formal challenge against canon evidence ────────────────
//
// The opener's vote counts immediately; other peers then vote to support or
// defend over a 21-day window.
//
// txHash — confirmed on-chain transaction hash (null in dev mode / no contract)
//
// `sig` is now the EIP-712 **Vote** signature (phase 1, support true) the chain
// recovered; the trailing `vote` object (round / noteHash / bindingHash) lets
// verify-attestation rebuild the same Vote digest. Defaults to {} so older
// callers that pass nothing keep working.
export async function openChallenge(binding, peerAddr, peerHandle, reason, sig, txHash = null, peerCount, vote = {}) {
  // Single edge-function call: writes opener's attestation AND flips the
  // binding status to contested atomically on the server side (service role).
  await withRetry(() => insertAttestation({
    evidence_id: binding.id, topic_id: binding.topicId, binding_id: binding.bindingId,
    peer_addr: peerAddr, peer_handle: peerHandle,
    phase: 'challenge', verdict: 'challenge', note: reason,
    eip712_sig: sig || null, tx_hash: txHash || null,
    round: vote.round ?? null, note_hash: vote.noteHash ?? null, binding_hash: vote.bindingHash ?? null,
    action: 'open_challenge',
    challenge_reason: reason,
  }));
  return {};
}

// ── Challenge vote: support the challenge or defend the evidence ─────────────
//
// txHash — confirmed on-chain transaction hash (null in dev mode / no contract)
// peerCount — live active-peer count from the contract
//
// `sig` is the EIP-712 **Vote** signature (phase 1) the chain recovered; the
// trailing `vote` object (round / noteHash / bindingHash) lets
// verify-attestation rebuild the same Vote digest.
export async function castChallengeVote(binding, supportChallenge, peerAddr, peerHandle, note, sig, txHash = null, peerCount, vote = {}) {
  const windowMs = CHALLENGE_WINDOW_DAYS * 86_400_000;
  const windowExpired = binding.challenged_at &&
    (Date.now() - new Date(binding.challenged_at).getTime()) > windowMs;
  if (windowExpired) throw new Error('Challenge window has expired');

  const verdict = supportChallenge ? 'challenge' : 'defend';
  const result  = await withRetry(() => insertAttestation({
    evidence_id: binding.id, topic_id: binding.topicId, binding_id: binding.bindingId,
    peer_addr: peerAddr, peer_handle: peerHandle,
    phase: 'challenge', verdict, note: note || null,
    eip712_sig: sig || null, tx_hash: txHash || null,
    round: vote.round ?? null, note_hash: vote.noteHash ?? null, binding_hash: vote.bindingHash ?? null,
    action: 'challenge_vote',
  }));
  return {
    challengeVotes: result.data?.challenge_votes ?? 0,
    defenseVotes:   result.data?.defense_votes   ?? 0,
  };
}

// ── Finalize challenge after the 21-day window closes ────────────────────────
//
// Mirrors finalizeChallenge() on the contract.  Must be called by a peer after
// the window expires.  Resolves to 'reaffirmed' if defense won, 'canon' if the
// challenge failed without reaching the deprecation threshold.
//
export async function finalizeChallengeSupabase(binding, peerAddr, peerCount, txHash = null) {
  const windowMs = CHALLENGE_WINDOW_DAYS * 86_400_000;
  const windowExpired = binding.challenged_at &&
    (Date.now() - new Date(binding.challenged_at).getTime()) > windowMs;
  if (!windowExpired) throw new Error('Challenge window is still open');

  const { data, error } = await supabase.functions.invoke('verify-attestation', {
    body: {
      evidence_id: binding.id, topic_id: binding.topicId, binding_id: binding.bindingId,
      peer_addr: peerAddr, action: 'finalize_challenge', tx_hash: txHash,
    },
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  return { status: data.status };
}
