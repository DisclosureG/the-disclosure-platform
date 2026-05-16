import { useState, useEffect, useCallback } from 'react';
import { supabase } from './lib/supabase';

// ── Pillars ──────────────────────────────────────────────────────────────────
export const PILLARS = [
  { n: "01", id: "music",                  title: "Music",                  tag: "Frequency · Soul",    blurb: "Sound as the first language of the multiverse. The harmonic substrate that lets souls recognise each other." },
  { n: "02", id: "psychedelics",           title: "Psychedelics",           tag: "Healing · Truth",     blurb: "Compounds that lift the veil. Can Reproduce mystical experiences in a safe setting." },
  { n: "03", id: "telepathy",              title: "Telepathy",              tag: "Mind-to-mind",        blurb: "The hardest case to ignore — non-speaking autistics doing the impossible, on camera, repeatedly." },
  { n: "04", id: "mindsight",              title: "Mindsight",              tag: "Inner perception",    blurb: "Seeing without eyes. Children trained to read text and identify colours while fully blindfolded." },
  { n: "05", id: "remote-viewing",         title: "Remote Viewing",         tag: "Non-local sight",     blurb: "Twenty-three years of CIA research. Declassified. The documents are not in dispute." },
  { n: "06", id: "out-of-body",            title: "Out of Body",            tag: "Soul travel",         blurb: "Cardiac arrest survivors describing the operating room from the ceiling. The data is now boring." },
  { n: "07", id: "non-human-intelligence", title: "Non-Human Intelligence", tag: "Disclosure",          blurb: "From AAWSAP to congressional testimony — the question is no longer whether, but how we relate." },
  { n: "08", id: "multiverse",             title: "Multiverse",             tag: "Infinite arenas",     blurb: "Synchronicity as evidence. The universe signalling that it sees you." },
  { n: "09", id: "infinity",               title: "Infinity",               tag: "Fractal · Eternal",   blurb: "Self-similar, scale-invariant, endless. The fractal thumbprint of God." },
];

const PILLAR_MAP = Object.fromEntries(PILLARS.map(p => [p.id, p]));

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
  const pct = { 1: 0.45, 2: 0.35, 3: 0.30 };
  return Math.max(1, Math.ceil(peers * (pct[tier] ?? 0.35)));
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
  pending:    'Pending review',
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
  const pillar = PILLAR_MAP[row.pillar_id] || {};
  return {
    ...row,
    pillarId:    row.pillar_id,
    pillarTitle: pillar.title || row.pillar_id,
    pillarNum:   pillar.n || '??',
  };
}

const PAGE_SIZE = 24;

const VISIBLE_STATUSES = ['canon', 'approved', 'reaffirmed', 'contested', 'deprecated'];

// Statuses included in numeric tallies — VISIBLE_STATUSES minus 'deprecated',
// so no count ever reflects evidence the network has retired.
const COUNTED_STATUSES = VISIBLE_STATUSES.filter(s => s !== 'deprecated');

const ORDER_MAP = {
  'pillar':    { col: 'pillar_id', asc: true  },
  'tier':      { col: 'tier',      asc: true  },
  'year-desc': { col: 'year',      asc: false },
  'year-asc':  { col: 'year',      asc: true  },
  'title':     { col: 'title',     asc: true  },
};

// ── Archive hook  (canon, reaffirmed, contested, deprecated) ─────────────────
//
// Default pillar view (no search, no type/tier filter) fetches all items so
// pillar grouping is unbroken.  All other combinations paginate at PAGE_SIZE.
//
export function useEvidence(searchQuery = '', type = 'All', tier = 'all', sortBy = 'pillar') {
  const [items, setItems]     = useState([]);
  const [total, setTotal]     = useState(null);
  const [page, setPage]       = useState(0);
  const [loading, setLoading] = useState(true);

  const isPaged = sortBy !== 'pillar' || !!searchQuery.trim() || type !== 'All' || tier !== 'all';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPage(0);
    setTotal(null);

    const trimmed = searchQuery.trim();
    const order   = ORDER_MAP[sortBy] || ORDER_MAP.pillar;

    let q = supabase
      .from('evidence')
      .select('*', isPaged ? { count: 'exact' } : undefined)
      .in('status', VISIBLE_STATUSES);

    if (trimmed)      q = q.textSearch('fts', trimmed);
    if (type !== 'All') q = q.eq('type', type);
    if (tier !== 'all') q = q.eq('tier', parseInt(tier, 10));

    q = q.order(order.col, { ascending: order.asc }).order('id', { ascending: true });
    if (isPaged) q = q.range(0, PAGE_SIZE - 1);

    q.then(({ data, count }) => {
      if (cancelled) return;
      setItems((data || []).map(normalize));
      if (isPaged) setTotal(count ?? 0);
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [searchQuery, type, tier, sortBy]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = () => {
    const next   = page + 1;
    const trimmed = searchQuery.trim();
    const order   = ORDER_MAP[sortBy] || ORDER_MAP.pillar;
    setPage(next);
    setLoading(true);

    let q = supabase
      .from('evidence')
      .select('*')
      .in('status', VISIBLE_STATUSES);

    if (trimmed)        q = q.textSearch('fts', trimmed);
    if (type !== 'All') q = q.eq('type', type);
    if (tier !== 'all') q = q.eq('tier', parseInt(tier, 10));

    q.order(order.col, { ascending: order.asc })
     .order('id', { ascending: true })
     .range(next * PAGE_SIZE, next * PAGE_SIZE + PAGE_SIZE - 1)
     .then(({ data }) => {
       setItems(prev => [...prev, ...(data || []).map(normalize)]);
       setLoading(false);
     });
  };

  const hasMore = isPaged && total !== null && items.length < total;

  const addOptimistic = (item) =>
    setItems(prev => [...prev, normalize({ ...item, status: 'pending' })]);

  return { evidence: items, loading, total, hasMore, loadMore, addOptimistic };
}

// ── Per-pillar counts hook — unfiltered totals for the Pillars grid ──────────
export function usePillarCounts() {
  const [counts, setCounts] = useState({});

  useEffect(() => {
    const base = (id) => supabase
      .from('evidence')
      .select('*', { count: 'exact', head: true })
      .in('status', COUNTED_STATUSES)
      .eq('pillar_id', id);

    Promise.all(PILLARS.map(p => base(p.id))).then(results => {
      const next = {};
      PILLARS.forEach((p, i) => { next[p.id] = results[i].count ?? 0; });
      setCounts(next);
    });
  }, []);

  return counts;
}

// ── Per-type counts hook — unfiltered totals for the type-chip row ───────────
export function useTypeCounts() {
  const [counts, setCounts] = useState({});

  useEffect(() => {
    supabase
      .from('evidence')
      .select('type')
      .in('status', COUNTED_STATUSES)
      .then(({ data }) => {
        const tally = {};
        (data || []).forEach(r => {
          if (!r.type) return;
          tally[r.type] = (tally[r.type] ?? 0) + 1;
        });
        setCounts(tally);
      });
  }, []);

  return counts;
}

// ── Tier counts hook — unfiltered totals for Hero stats ───────────────────────
export function useTierCounts() {
  const [counts, setCounts] = useState({ total: 0, tier1: 0, tier2: 0, tier3: 0 });

  useEffect(() => {
    const base = () => supabase.from('evidence').select('*', { count: 'exact', head: true }).in('status', COUNTED_STATUSES);
    Promise.all([
      base(),
      base().eq('tier', 1),
      base().eq('tier', 2),
      base().eq('tier', 3),
    ]).then(([all, t1, t2, t3]) => {
      setCounts({
        total: all.count ?? 0,
        tier1: t1.count  ?? 0,
        tier2: t2.count  ?? 0,
        tier3: t3.count  ?? 0,
      });
    });
  }, []);

  return counts;
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

// ── Pending queue hook  (evidence waiting for peer attestations) ─────────────
export function usePendingEvidence() {
  const [queue, setQueue]   = useState([]);
  const [loading, setLoading] = useState(true);

  const refetch = () =>
    supabase
      .from('evidence')
      .select('*, attestations(*)')
      .eq('status', 'pending')
      .eq('submitted_onchain', true)  // hide rows not yet on-chain
      .order('submitted_at', { ascending: true })
      .then(({ data }) => {
        setQueue((data || []).map(normalize));
        setLoading(false);
      });

  useEffect(() => {
    refetch();
    // Server-side filter on the `evidence` channel scopes events to pending
    // rows only — every other status change is dropped on the server, not the
    // client.  `attestations` has no `status` column so we filter to the
    // hot path verdicts in JS via the debounced refetch.
    const debouncedRefetch = debounce(refetch, 200);
    const ch = supabase
      .channel('pending-queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'evidence', filter: 'status=eq.pending' }, debouncedRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attestations',
                                filter: 'phase=eq.review' }, debouncedRefetch)
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, []);

  return { queue, loading, refetch };
}

// Submissions awaiting on-chain registration.  Anyone with a wallet may
// register; non-peers can flag a peer who can do it.
//
// We pull the full content payload so the registering peer can recompute
// content_hash locally and bind it on-chain in the same submitEvidence call.
export function useUnchainedPending() {
  const [items, setItems]   = useState([]);
  const [loading, setLoading] = useState(true);

  const refetch = () =>
    supabase
      .from('evidence')
      .select('id, title, tier, pillar_id, source, year, excerpt, link, submitted_at, status')
      .eq('status', 'pending')
      .eq('submitted_onchain', false)
      .order('submitted_at', { ascending: true })
      .then(({ data }) => {
        setItems((data || []).map(normalize));
        setLoading(false);
      });

  useEffect(() => {
    refetch();
    const debouncedRefetch = debounce(refetch, 200);
    // Pending rows fan in here; once submitted_onchain flips we drop them.
    // Realtime filter narrows to pending status only.
    const ch = supabase
      .channel('unchained-pending')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'evidence', filter: 'status=eq.pending' }, debouncedRefetch)
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, []);

  return { items, loading, refetch };
}

// Tamper alerts — rows the audit-content-hash edge function writes when an
// evidence row's stored content_hash no longer matches its canonical hash.
// Live-updated via realtime so a fresh alert appears without needing the
// operator to refresh the page.
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
      .channel('tamper-alerts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tamper_alerts' }, debouncedRefetch)
      .subscribe();
    return () => supabase.removeChannel(ch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit]);

  return { alerts, loading };
}

// Edge function heartbeat — populated by chain-indexer + audit-content-hash
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
    const ch = supabase
      .channel('heartbeats')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'edge_function_heartbeat' }, () => refetch())
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, []);

  return { rows, loading };
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
      .then(({ data, count }) => {
        setEvents(data || []);
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
      .then(({ data, count }) => {
        if (cancelled) return;
        setEvents(data || []);
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
      .then(({ data }) => {
        setEvents(prev => [...prev, ...(data || [])]);
        setLoading(false);
      });
  };

  const hasMore = total === null ? events.length === (page + 1) * pageSize : events.length < total;

  return { events, loading, hasMore, loadMore, total, refetch };
}

// ── Contested evidence hook  (canon items under active challenge) ────────────
export function useContestedEvidence() {
  const [contested, setContested] = useState([]);
  const [loading, setLoading]     = useState(true);

  const refetch = () => {
    supabase
      .from('evidence')
      .select('*, attestations(*)')
      .eq('status', 'contested')
      .order('challenged_at', { ascending: false })
      .then(({ data }) => {
        setContested((data || []).map(normalize));
        setLoading(false);
      });
  };

  useEffect(() => {
    refetch();
    const debouncedRefetch = debounce(refetch, 200);
    const ch = supabase
      .channel('contested-queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'evidence',
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

export function useCanonEvidence(query = '') {
  const [canon, setCanon]     = useState([]);
  const [page, setPage]       = useState(0);
  const [total, setTotal]     = useState(null);
  const [loading, setLoading] = useState(true);

  const trimmed = (query ?? '').trim();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPage(0);
    setTotal(null);

    let q = supabase
      .from('evidence')
      .select('id, title, tier, pillar_id, source, year, status', { count: 'estimated' })
      .in('status', ['canon', 'approved', 'reaffirmed']);

    if (trimmed) q = q.textSearch('fts', trimmed);

    q.order('pillar_id', { ascending: true })
     .order('id',        { ascending: true })
     .range(0, CANON_PAGE - 1)
     .then(({ data, count }) => {
       if (cancelled) return;
       setCanon((data || []).map(normalize));
       setTotal(count ?? null);
       setLoading(false);
     });

    return () => { cancelled = true; };
  }, [trimmed]);

  const loadMore = () => {
    const next = page + 1;
    setPage(next);
    setLoading(true);

    let q = supabase
      .from('evidence')
      .select('id, title, tier, pillar_id, source, year, status')
      .in('status', ['canon', 'approved', 'reaffirmed']);

    if (trimmed) q = q.textSearch('fts', trimmed);

    q.order('pillar_id', { ascending: true })
     .order('id',        { ascending: true })
     .range(next * CANON_PAGE, next * CANON_PAGE + CANON_PAGE - 1)
     .then(({ data }) => {
       setCanon(prev => [...prev, ...(data || []).map(normalize)]);
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
  // characters that have special meaning in PostgREST syntax (`,()*"`)
  // so they can't break out of the ilike pattern.
  const q = query.trim().replace(/[,()*"]/g, '');
  const v = ['approve', 'reject', 'challenge', 'defend'].includes(verdict) ? verdict : '';

  const applyFilters = (req) => {
    if (v) req = req.eq('verdict', v);
    if (q) req = req.or(`peer_handle.ilike.%${q}%,peer_addr.ilike.%${q}%`);
    return req;
  };

  const refetch = useCallback(() => {
    setLoading(true);
    setPage(0);
    setTotal(null);
    return applyFilters(
      supabase
        .from('attestations')
        .select('*, evidence(title)', { count: 'estimated' })
        .order('created_at', { ascending: false })
    )
      .range(0, pageSize - 1)
      .then(({ data, count }) => {
        setLog(data || []);
        setTotal(count ?? null);
        setLoading(false);
      });
  // applyFilters closes over q/v; pageSize is a dep too.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize, q, v]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPage(0);
    setTotal(null);

    applyFilters(
      supabase
        .from('attestations')
        .select('*, evidence(title)', { count: 'estimated' })
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
  }, [pageSize, q, v]);

  const loadMore = () => {
    const next = page + 1;
    setPage(next);
    setLoading(true);

    applyFilters(
      supabase
        .from('attestations')
        .select('*, evidence(title)')
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
export async function castReviewVote(item, verdict, peerAddr, peerHandle, note, sig, txHash = null, peerCount) {
  const result = await withRetry(() => insertAttestation({
    evidence_id: item.id, peer_addr: peerAddr, peer_handle: peerHandle,
    phase: 'review', verdict, note: note || null,
    eip712_sig: sig || null, tx_hash: txHash || null,
    action: 'review_vote',
  }));
  return {
    approvals:  result.data?.approve_count ?? 0,
    rejections: result.data?.reject_count  ?? 0,
  };
}

// ── Mark evidence as on-chain after submitEvidenceOnChain confirmed ──────────
//
// The edge function verifies the tx hash contains an EvidenceSubmitted event
// for the given uuid and peer, then flips submitted_onchain to true.
//
export async function markEvidenceOnchain(evidenceId, peerAddr, txHash) {
  await withRetry(() => insertAttestation({
    evidence_id: evidenceId, peer_addr: peerAddr,
    tx_hash: txHash,
    action: 'register_evidence_onchain',
  }));
}

// ── Challenge: open a formal challenge against canon evidence ────────────────
//
// The opener's vote counts immediately; other peers then vote to support or
// defend over a 21-day window.
//
// txHash — confirmed on-chain transaction hash (null in dev mode / no contract)
//
export async function openChallenge(item, peerAddr, peerHandle, reason, sig, txHash = null, peerCount) {
  // Single edge-function call: writes opener's attestation AND flips evidence
  // status to contested atomically on the server side (service role).
  await withRetry(() => insertAttestation({
    evidence_id: item.id, peer_addr: peerAddr, peer_handle: peerHandle,
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
export async function castChallengeVote(item, supportChallenge, peerAddr, peerHandle, note, sig, txHash = null, peerCount) {
  const windowMs = CHALLENGE_WINDOW_DAYS * 86_400_000;
  const windowExpired = item.challenged_at &&
    (Date.now() - new Date(item.challenged_at).getTime()) > windowMs;
  if (windowExpired) throw new Error('Challenge window has expired');

  const verdict = supportChallenge ? 'challenge' : 'defend';
  const result  = await withRetry(() => insertAttestation({
    evidence_id: item.id, peer_addr: peerAddr, peer_handle: peerHandle,
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
export async function finalizeChallengeSupabase(item, peerAddr, peerCount, txHash = null) {
  const windowMs = CHALLENGE_WINDOW_DAYS * 86_400_000;
  const windowExpired = item.challenged_at &&
    (Date.now() - new Date(item.challenged_at).getTime()) > windowMs;
  if (!windowExpired) throw new Error('Challenge window is still open');

  const { data, error } = await supabase.functions.invoke('verify-attestation', {
    body: { evidence_id: item.id, peer_addr: peerAddr, action: 'finalize_challenge', tx_hash: txHash },
  });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  return { status: data.status };
}
