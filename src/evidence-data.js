import { useState, useEffect, useCallback } from 'react';
import { supabase } from './lib/supabase';

// ── Taxonomy: Pillar → Topic ──────────────────────────────────────────────────
//
// Pillars (wider) and topics (deeper) are governed on-chain and projected into
// the `pillars` / `topics` Supabase tables.  We cache the ratified set at module
// scope so every hook — and the synchronous normalize() below — shares one copy
// instead of refetching.  ensureTaxonomy() is idempotent; useTaxonomy() exposes
// the live, reshaped tree to React.

let _taxonomy = { pillars: [], topics: [], pillarMap: {}, topicMap: {}, loaded: false };
let _taxonomyPromise = null;

async function loadTaxonomy() {
  const [{ data: pillars }, { data: topics }] = await Promise.all([
    supabase.from('pillars').select('*').eq('status', 'ratified').order('ord', { ascending: true }),
    supabase.from('topics').select('*').eq('status', 'ratified').order('ord', { ascending: true }),
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
      .select(BINDING_SELECT.replace('evidence:evidence_id(', 'evidence:evidence_id!inner('),
              counted ? { count: 'exact' } : undefined)
      .in('status', VISIBLE_STATUSES);
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
    // on the joined evidence, so we inner-join and filter on evidence.tier.
    const fetchCounts = () => {
      const base = () => supabase
        .from('bindings')
        .select('evidence:evidence_id!inner(tier)', { count: 'exact', head: true })
        .in('status', COUNTED_STATUSES);
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
        base().eq('status', 'pending'),
        base().eq('status', 'contested'),
        base().in('status', CANON_STATUSES),
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
// attestations.peer_handle only on the signed write path. When the indexer
// backfills a gap row (vote mined on-chain but the off-chain signed write was
// lost), the row carries no handle and the feed would show a bare address. This
// builds an addr→handle map from every attestation that DID capture a handle, so
// the same peer's known handle can stand in. Pure off-chain, no wallet/RPC, so it
// works for logged-out visitors on the home feed.
export function usePeerHandleMap() {
  const [map, setMap] = useState({});
  useEffect(() => {
    let cancelled = false;
    supabase
      .from('attestation_log_view')
      .select('peer_addr, peer_handle')
      .not('peer_handle', 'is', null)
      .order('created_at', { ascending: false })
      .limit(2000)
      .then(({ data }) => {
        if (cancelled || !data) return;
        const m = {};
        for (const r of data) {
          const a = r.peer_addr?.toLowerCase();
          if (a && r.peer_handle && !m[a]) m[a] = r.peer_handle;
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
        .select('id, created_at, peer_handle, peer_addr, phase, verdict, evidence_title, evidence_id, binding_id, pillar_id, topic_id, tx_hash, note, eip712_sig')
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

  // We query the `attestation_log_view` (migration 20260517010000, extended
  // 20260519000000) which flattens evidence.search_text + evidence.title +
  // evidence_id::text onto each attestation row. PostgREST `or=(...)` doesn't
  // accept dotted paths to embedded resources, so the view lets a single
  // per-term OR filter cover handle, address, the full evidence searchable
  // surface (title + source + excerpt + body + quote + tags), and the UUID
  // (full or prefix copied from an archive card).
  const FROM_VIEW = 'attestation_log_view';

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
export async function castReviewVote(binding, verdict, peerAddr, peerHandle, note, sig, txHash = null, peerCount) {
  const result = await withRetry(() => insertAttestation({
    evidence_id: binding.id, topic_id: binding.topicId, binding_id: binding.bindingId,
    peer_addr: peerAddr, peer_handle: peerHandle,
    phase: 'review', verdict, note: note || null,
    eip712_sig: sig || null, tx_hash: txHash || null,
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
export async function endorseNodeSupabase({ nodeHash, evidenceId, topicId, bindingId, peerAddr, peerHandle, note, sig, txHash = null }) {
  await withRetry(() => insertAttestation({
    evidence_id: evidenceId, topic_id: topicId, binding_id: bindingId,
    node_hash: nodeHash,
    peer_addr: peerAddr, peer_handle: peerHandle,
    phase: 'taxonomy', verdict: 'endorse', note: note || null,
    eip712_sig: sig || null, tx_hash: txHash || null,
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
export async function openChallenge(binding, peerAddr, peerHandle, reason, sig, txHash = null, peerCount) {
  // Single edge-function call: writes opener's attestation AND flips the
  // binding status to contested atomically on the server side (service role).
  await withRetry(() => insertAttestation({
    evidence_id: binding.id, topic_id: binding.topicId, binding_id: binding.bindingId,
    peer_addr: peerAddr, peer_handle: peerHandle,
    phase: 'challenge', verdict: 'challenge', note: reason,
    eip712_sig: sig || null, tx_hash: txHash || null,
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
export async function castChallengeVote(binding, supportChallenge, peerAddr, peerHandle, note, sig, txHash = null, peerCount) {
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
