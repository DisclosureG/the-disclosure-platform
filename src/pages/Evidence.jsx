import { useState, useEffect, useMemo, useRef, useCallback, Children, cloneElement } from 'react';
import { useTaxonomy, useEvidence, useTierCounts, useQueuedBindings, useIndexerHealth, useEvidenceVotes, usePeerHandleMap, openChallenge } from '../evidence-data';
import { supabase } from '../lib/supabase';
import { isPeerActive, getPeerHandle, signVoteOnly, openChallengeOnChain, submitEvidenceOnChain, fileBindingOnChain, waitForTx, CONSENSUS_ADDR, getChallengeCooldownRemaining, getBoostCooldownRemaining, computeContentHash, bindingKey, slugToBytes32, connectWallet, switchToTargetChain, boostQueuedOnChain } from '../lib/wallet';
import { markBindingOnchain } from '../evidence-data';
import CopyChip from '../components/CopyChip';
import AttestationVerifier from '../components/AttestationVerifier';
import EvidenceDetailBody from '../components/EvidenceDetailBody';
import WalletButton from '../components/WalletButton';
import { BrandSigil } from '../components/Sparkle';
import { fireConfetti } from '../lib/confetti';
import '../styles/shared.css';
import '../styles/evidence.css';

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

// Roman numeral for a pillar's positional index (observatory grammar).
function toRoman(num) {
  const map = [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
  let n = num, out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out || '—';
}

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24); return `${d} d ago`;
}

// Vote-history verdict display. Taxonomy endorsements ('endorse') are the same
// act as a review approval, so they read as "Approved" (mirrors Home + Peer
// Review). `verdictClass` maps to the colour class defined in evidence.css.
const VERDICT_LABEL = { approve: 'Approved', endorse: 'Approved', reject: 'Rejected', challenge: 'Challenged', defend: 'Defended' };
const verdictClass = (v) => (v === 'endorse' ? 'approve' : v);
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

const STATUS_PILL = {
  canon:      { label: 'In archive', cls: 'pill--canon' },
  approved:   { label: 'In archive', cls: 'pill--canon' },
  reaffirmed: { label: 'Upheld',     cls: 'pill--reaffirmed' },
  contested:  { label: 'Contested',  cls: 'pill--contested' },
  deprecated: { label: 'Removed',    cls: 'pill--deprecated' },
  pending:    { label: 'Pending',    cls: 'pill--pending' },
};

// Card order within a topic's carousel: canon family first, then contested,
// with deprecated always pushed to the end. Unknown statuses (e.g. queued in
// vote mode) sit in the middle; the sort is stable so each group keeps its
// incoming order (date / queue priority).
const STATUS_ORDER = { canon: 0, approved: 0, reaffirmed: 0, contested: 1, deprecated: 2 };
const statusRank = (s) => (STATUS_ORDER[s] ?? 1);

function StatusPill({ status }) {
  const cfg = STATUS_PILL[status];
  if (!cfg) return null;
  return <span className={`ev-pill ${cfg.cls}`}><span className="dot" />{cfg.label}</span>;
}

function TierBadge({ tier }) {
  const label = tier === 1 ? 'Tier I' : tier === 2 ? 'Tier II' : 'Tier III';
  return (
    <span className="ev-badge-tier" data-tier={tier}>
      <span className="bar"><i /><i /><i /></span>{label}
    </span>
  );
}

function Nav() {
  return (
    <nav className="nav">
      <div className="nav-inner">
        <a href="/" className="brand">
          <BrandSigil />
          <span className="brand-text">The Disclosure Platform<small>DeSci · Evidence Network</small></span>
        </a>
        <div className="nav-links">
          <a href="/">Home</a>
          <a href="#top" className="is-active">Evidence</a>
          <a href="/peer-review/">Peer Review</a>
        </div>
        <div className="nav-right">
          <WalletButton />
        </div>
      </div>
    </nav>
  );
}

function Hero({ counts, contractAddr }) {
  const idx = useIndexerHealth();
  const short = contractAddr ? `${contractAddr.slice(0, 4)}…${contractAddr.slice(-4)}` : null;

  return (
    <header id="top" className="ev-hero">
      <div className="ev-hero-inner">
        <div className="ev-hero-top">
          <div className="eyebrow ev-eyebrow">Evidence · The public archive</div>
          <h1 className="ev-display">Evidence<br />for the<br /><em>record.</em></h1>
          <p className="ev-lead">
            Sourced and checkable. Reviewed by named peers. Saved to a permanent
            public record. Organised by category and subtopic, ranked by how strong
            the source is, and open to the world.
            <strong> Anyone can vote on a submission to move it up the review line</strong> — so peers look at the most-wanted evidence first.
          </p>
        </div>

        <aside className="ev-counter">
          <div className="ev-counter-head">
            <span title="Updated in real-time as peers vote">Live</span>
            <span className="ev-dot" aria-label="Live" title="Live" />
          </div>
          <p className="ev-counter-num">
            <span className="digit">{counts.total.toLocaleString()}</span>
            <span className="unit">entries</span>
          </p>
          <div className="ev-counter-sub">
            <div><b style={{ color: 'var(--tier-1)' }}>{counts.tier1}</b><span>Tier I</span></div>
            <div><b style={{ color: 'var(--tier-2)' }}>{counts.tier2}</b><span>Tier II</span></div>
            <div><b style={{ color: 'var(--tier-3)' }}>{counts.tier3}</b><span>Tier III</span></div>
          </div>
        </aside>

        <div className="ev-hero-foot">
          <div className="ev-onchain" aria-label="Public record status">
            <span><span className="k">Network</span><span className="v v--bsc">BNB Chain</span></span>
            {short && (
              <span><span className="k">Public record</span>
                <a className="v" href={`https://bscscan.com/address/${contractAddr}`} target="_blank" rel="noopener noreferrer">View it ↗</a>
              </span>
            )}
            <span><span className="k">Live sync</span><span className={`ev-indexer ev-indexer--${idx.state}`} title={idx.lastSuccess ? `${idx.label} · last sync ${timeAgo(idx.lastSuccess)}` : idx.label}>{idx.short}</span></span>
          </div>
        </div>
      </div>
    </header>
  );
}

function TierStrip({ counts }) {
  const tiers = [
    { n: 1, name: 'Tier I',   desc: 'Peer-reviewed papers & declassified record.' },
    { n: 2, name: 'Tier II',  desc: 'Documented — books, institutional record, art.' },
    { n: 3, name: 'Tier III', desc: 'Testimony — first-person, sworn or named.' },
  ];
  return (
    <section className="ev-tier-strip" aria-label="Tier coding">
      <div className="ev-tier-strip-inner">
        <div className="strip-label">
          <span className="eyebrow ev-eyebrow">Tier coding</span>
        </div>
        {tiers.map(t => (
          <div key={t.n} className="strip-tier" data-tier={t.n}>
            <span className="strip-bar"><i /><i /><i /></span>
            <span className="strip-name">{t.name}<small>{t.desc}</small></span>
          </div>
        ))}
      </div>
    </section>
  );
}

// Dropdown index over all pillars — replaces the floating side-rail so the
// archive stays navigable as pillars multiply (wider). Jumps to a section.
function PillarPicker({ pillars, counts, active, onJump }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    if (open) document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, [open]);

  const current = pillars.find(p => p.id === active) || pillars[0];
  const f = filter.trim().toLowerCase();
  const list = pillars.filter(p => !f || p.title.toLowerCase().includes(f) || (p.tag || '').toLowerCase().includes(f));

  return (
    <div className={`ev-pillar-picker${open ? ' is-open' : ''}`} ref={ref}>
      <button type="button" className="ev-picker-summary" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="ev-picker-n">P-{current?.n}</span>
        <span className="ev-picker-current">{current?.title}</span>
        <span className="ev-picker-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="ev-picker-panel">
          <div className="ev-picker-head">
            <span className="label">{pillars.length} pillar{pillars.length === 1 ? '' : 's'}</span>
          </div>
          <div className="ev-picker-search">
            <SearchIcon />
            <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter pillars…" />
          </div>
          <ul className="ev-picker-list">
            {list.map(p => (
              <li key={p.id}>
                <button type="button" className={p.id === active ? 'is-active' : ''} onClick={() => { onJump(p.id); setOpen(false); }}>
                  <span className="n">{p.n}</span>
                  <span className="name">{p.title}</span>
                  <span className="count">{p.id === active && <span className="pulse" />}{counts[p.id] || 0}</span>
                </button>
              </li>
            ))}
            {list.length === 0 && <li className="ev-picker-none">No pillars match.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

// Sticky search-first shelf: global search (keyboard "/"), submit/propose
// actions, and the filter row (pillar picker + tier chips).
function Shelf({ q, setQ, tier, setTier, structural, pillars, counts, activePillar, onJump, onSubmit, mode, setMode }) {
  const inputRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const tierChips = [
    { id: 'all', label: 'All' },
    { id: '1',   label: 'Tier I' },
    { id: '2',   label: 'Tier II' },
    { id: '3',   label: 'Tier III' },
  ];

  return (
    <div className="ev-shelf">
      <div className="ev-shelf-inner">
        <div className="ev-shelf-row1">
          <div className="ev-search ev-search-lg">
            <SearchIcon />
            <input
              ref={inputRef}
              type="text"
              placeholder={mode === 'vote' ? 'Search evidence awaiting review' : 'Search Evidence'}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <kbd>/</kbd>
          </div>
          <div className="ev-shelf-actions">
            <div className="ev-mode-toggle" role="tablist" aria-label="View mode">
              <button type="button" role="tab" aria-selected={mode === 'archive'} className={mode === 'archive' ? 'is-active' : ''} onClick={() => setMode('archive')}>Archive</button>
              <button type="button" role="tab" aria-selected={mode === 'vote'} className={mode === 'vote' ? 'is-active' : ''} onClick={() => setMode('vote')}>Vote</button>
            </div>
            <button className="ev-btn ev-btn-primary" onClick={onSubmit}>+ Submit evidence</button>
          </div>
        </div>
        <div className="ev-shelf-filters">
          {structural && pillars.length > 0 && (
            <PillarPicker pillars={pillars} counts={counts} active={activePillar} onJump={onJump} />
          )}
          <div className="ev-chip-row" role="tablist" aria-label="Filter by tier">
            {tierChips.map(t => (
              <button key={t.id} className={`ev-chip ${tier === t.id ? 'is-active' : ''}`} onClick={() => setTier(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function EvCard({ e, onOpen, onVotes, vote, style }) {
  const isDeprecated = e.status === 'deprecated';
  const isQueued = e.status === 'queued';
  const shortId = e.id ? `${String(e.id).slice(0, 8)}…` : '';
  const handleActivate = () => onOpen(e);
  return (
    <article
      id={`ev-${e.id}`}
      role="button"
      tabIndex={0}
      style={style}
      data-tier={e.tier}
      className={`ev-card${isDeprecated ? ' is-deprecated' : e.status === 'contested' ? ' is-contested' : ''}`}
      onClick={handleActivate}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); handleActivate(); }
      }}
    >
      <div className="ev-card-top">
        <span className="ev-card-type">{e.type}</span>
        <TierBadge tier={e.tier} />
        {isQueued ? <span className="ev-pill pill--pending"><span className="dot" />Queued</span> : <StatusPill status={e.status} />}
      </div>
      <h3 className="ev-card-title">{e.title}</h3>
      <p className="ev-card-src">
        {e.source}{e.source && e.year ? ' · ' : ''}<span className="yr">{e.year}</span>
      </p>
      <p className="ev-card-excerpt">{e.excerpt}</p>
      <div className="ev-card-foot">
        {vote ? (
          <>
            <span className="ev-card-id" title={`${e.pillarTitle} · ${e.topicTitle}`}>{e.pillarTitle} · {e.topicTitle}</span>
            <button
              className="ev-btn ev-btn-ghost ev-queue-boost"
              disabled={vote.busy === e.bindingId || vote.cooldownLeft > 0}
              onClick={(ev) => { ev.stopPropagation(); vote.boost(e); }}
              title={vote.cooldownLeft > 0 ? `Please wait — vote again in ${fmtCooldown(vote.cooldownLeft)}` : 'Vote to move this evidence up the review line'}
            >
              {vote.busy === e.bindingId ? 'Voting…' : vote.cooldownLeft > 0 ? `⏳ ${fmtCooldown(vote.cooldownLeft)}` : `✦ Vote · ${vote.votesFor(e)}`}
            </button>
          </>
        ) : (
          <>
            <span className="ev-card-id" title={`Evidence id · ${e.id}`}>
              ID · {shortId}
              <CopyChip value={e.id} label="evidence id" />
            </span>
            <span className="ev-card-foot-actions">
              {onVotes && (
                <button
                  type="button"
                  className="ev-card-votes"
                  onClick={(ev) => { ev.stopPropagation(); onVotes(e); }}
                  onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') ev.stopPropagation(); }}
                  title="See every signed vote on this evidence — who voted and how"
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 3v18h18" />
                    <path d="M7 14l3-3 3 3 4-5" />
                  </svg>
                  Who voted
                </button>
              )}
              <span className="ev-card-arrow">{isDeprecated ? 'In log →' : 'Open →'}</span>
            </span>
          </>
        )}
      </div>
    </article>
  );
}

// Per-wallet boost cooldown in ms — mirrors the contract's BOOST_COOLDOWN
// (10 minutes). Used only for optimistic UI; the contract is the real gate.
const BOOST_COOLDOWN_MS = 10 * 60 * 1000;

// mm:ss for short cooldown countdowns.
function fmtCooldown(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Public "Vote" (on-chain boost). Open submission scales, but peers can only
// review a bounded set at once; the rest wait in the queued pool. Anyone with a
// wallet casts ONE vote per queued binding to raise its priority, so the network
// reviews the most-wanted evidence first. Two anti-spam guards live on-chain:
// one vote per wallet per binding, plus a per-wallet cooldown between votes
// (active peers exempt) so a single wallet can't sweep-boost the whole queue.
// Votes only set the order; peers still decide what enters the archive. Shared
// by the vote-mode cards and the detail modal so the optimistic count, cooldown,
// and busy/err state stay in sync across both surfaces.
function useBoost(walletAddr, exempt) {
  const [busy, setBusy] = useState(null);
  const [boosted, setBoosted] = useState({}); // optimistic per-binding bump
  const [err, setErr] = useState(null);
  const [cooldownUntil, setCooldownUntil] = useState(0); // ms epoch; 0 = none
  const [, setTick] = useState(0);

  // Pull the connected wallet's on-chain boost cooldown when it changes.
  useEffect(() => {
    if (!walletAddr) { setCooldownUntil(0); return; }
    let live = true;
    getBoostCooldownRemaining(walletAddr).then(secs => {
      if (live) setCooldownUntil(secs > 0 ? Date.now() + secs * 1000 : 0);
    });
    return () => { live = false; };
  }, [walletAddr]);

  // Tick every second while a cooldown is counting down.
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [cooldownUntil]);

  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));

  const boost = async (e) => {
    setErr(null);
    setBusy(e.bindingId);
    try {
      await connectWallet();
      await switchToTargetChain();
      const topicId = await slugToBytes32(e.topicId);
      const tx = await boostQueuedOnChain(e.id, topicId);
      await waitForTx(tx);
      setBoosted(b => ({ ...b, [e.bindingId]: (b[e.bindingId] || 0) + 1 }));
      if (!exempt) setCooldownUntil(Date.now() + BOOST_COOLDOWN_MS);
    } catch (ex) {
      const rejected = ex?.code === 4001 || /reject|denied/i.test(ex?.message || '');
      if (rejected) {
        setErr(null);
      } else {
        // The contract is deployed with STRIP_REVERTS, so reverts carry no reason
        // string — re-read the on-chain cooldown to tell a cooldown revert apart
        // from the other require()s ("not queued" / "already boosted").
        let secs = 0;
        if (walletAddr) { try { secs = await getBoostCooldownRemaining(walletAddr); } catch { /* ignore */ } }
        if (secs > 0) {
          setCooldownUntil(Date.now() + secs * 1000);
          setErr('cooldown');
        } else {
          setErr('Vote failed — you may have already voted, or this evidence is no longer in the queue.');
        }
      }
    } finally {
      setBusy(null);
    }
  };

  const votesFor = (e) => (e.queue_priority || 0) + (boosted[e.bindingId] || 0);
  // 'cooldown' is a sentinel — render it as a live-ticking timer (cooldownLeft
  // re-renders every second), and clear it once the window elapses.
  const errText = err === 'cooldown'
    ? (cooldownLeft > 0 ? `Vote cooldown active — try again in ${fmtCooldown(cooldownLeft)}` : null)
    : err;
  return { boost, busy, err: errText, votesFor, cooldownLeft };
}

const arrowSvg = (points) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points={points} />
  </svg>
);

// Horizontal scroll-snap carousel: one "page" of cards per arrow click, with
// edge fades + a progress caption. Replaces numbered pagination per the design.
function CardRail({ children, itemKey }) {
  const gridRef = useRef(null);
  const rafRef = useRef(0);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);
  // Page geometry comes from the responsive --ev-card-cols/rows CSS vars so the
  // row-major placement below tracks the same breakpoints as the grid sizing.
  const [dims, setDims] = useState({ cols: 3, rows: 2 });

  const update = useCallback(() => {
    const g = gridRef.current;
    if (!g) return;
    const max = g.scrollWidth - g.clientWidth;
    setCanPrev(g.scrollLeft > 2);
    setCanNext(g.scrollLeft < max - 2);
  }, []);

  const measure = useCallback(() => {
    const g = gridRef.current;
    if (!g) return;
    const cs = getComputedStyle(g);
    const cols = parseInt(cs.getPropertyValue('--ev-card-cols'), 10) || 3;
    const rows = parseInt(cs.getPropertyValue('--ev-card-rows'), 10) || 2;
    setDims(prev => (prev.cols === cols && prev.rows === rows ? prev : { cols, rows }));
  }, []);

  useEffect(() => {
    update();
    measure();
    const onResize = () => { update(); measure(); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [update, measure, itemKey]);

  const onScroll = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; update(); });
  };
  const scroll = (dir) => {
    const g = gridRef.current;
    if (g) g.scrollBy({ left: dir * g.clientWidth, behavior: 'smooth' });
  };

  // Place each card at an explicit (row, column) so every page fills row 1 left
  // to right, then row 2 — instead of the grid's default column-major flow.
  const { cols, rows } = dims;
  const pageSize = cols * rows;
  const childArr = Children.toArray(children);
  // Collapse the second row when no page actually needs it, so a topic with
  // only one row of cards doesn't render empty space below.
  const usedRows = Math.min(rows, Math.max(1, childArr.reduce((max, _, i) => {
    const within = i % pageSize;
    return Math.max(max, Math.floor(within / cols) + 1);
  }, 1)));
  const placed = childArr.map((child, i) => {
    const within = i % pageSize;
    const c = within % cols;
    return cloneElement(child, {
      style: {
        ...(child.props.style || {}),
        gridColumn: Math.floor(i / pageSize) * cols + c + 1,
        gridRow: Math.floor(within / cols) + 1,
      },
    });
  });

  return (
    <div className="ev-pager-rail" data-can-scroll-prev={canPrev} data-can-scroll-next={canNext}>
      <button className="ev-scroll-arrow is-prev" aria-label="Previous page" disabled={!canPrev} onClick={() => scroll(-1)}>
        {arrowSvg('15,6 9,12 15,18')}
      </button>
      <div className="ev-grid" ref={gridRef} onScroll={onScroll} style={{ gridTemplateRows: `repeat(${usedRows}, 1fr)` }}>
        {placed}
      </div>
      <button className="ev-scroll-arrow is-next" aria-label="Next page" disabled={!canNext} onClick={() => scroll(1)}>
        {arrowSvg('9,6 15,12 9,18')}
      </button>
    </div>
  );
}

// One topic subsection inside a pillar: collapsible header + card carousel.
function TopicBlock({ pillarId, topic, items, onOpen, onVotes, vote }) {
  const [collapsed, setCollapsed] = useState(false);
  const counted = items.filter(e => e.status !== 'deprecated').length;
  const ordered = useMemo(
    () => [...items].sort((a, b) => statusRank(a.status) - statusRank(b.status)),
    [items],
  );
  const itemKey = ordered.map(e => e.id).join(',');
  const toggle = () => setCollapsed(c => !c);
  return (
    <div id={`${pillarId}--${topic.id}`} className={`ev-topic-block${collapsed ? ' is-collapsed' : ''}`}>
      <div
        className="ev-topic-head"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
      >
        <h3 className="ev-topic-title">{topic.title}</h3>
        <span className="ev-topic-count">{counted}</span>
        <span className="ev-chev" aria-hidden="true">{collapsed ? 'expand +' : 'collapse −'}</span>
      </div>
      {!collapsed && (
        <>
          {topic.blurb && <p className="ev-topic-blurb">{topic.blurb}</p>}
          {items.length === 0 ? (
            <div className="ev-empty ev-empty-topic">Nothing filed under {topic.title} yet — be the first.</div>
          ) : (
            <CardRail itemKey={itemKey}>
              {ordered.map(e => <EvCard key={e.bindingId || e.id} e={e} onOpen={onOpen} onVotes={onVotes} vote={vote} />)}
            </CardRail>
          )}
        </>
      )}
    </div>
  );
}

function PillarSection({ pillar, index, total, items, onOpen, onVotes, vote, voteMode, hideEmpty }) {
  const [topicFilter, setTopicFilter] = useState('all');
  const countedItems = items.filter(e => e.status !== 'deprecated').length;
  const topics = pillar.topics || [];

  const byTopic = useMemo(() => {
    const m = {};
    for (const e of items) (m[e.topicId] ||= []).push(e);
    return m;
  }, [items]);
  const knownIds = new Set(topics.map(t => t.id));
  const orphans  = items.filter(e => !knownIds.has(e.topicId));

  // Vote mode and the tier-filtered archive both narrow the tree to nodes that
  // actually hold matching evidence — drop chips + blocks for empty topics so
  // the filtered structure reads cleanly instead of as a wall of empties.
  const dropEmpty = voteMode || hideEmpty;
  const visibleTopics = topics.filter(t => topicFilter === 'all' || t.id === topicFilter);
  const chipTopics = dropEmpty ? topics.filter(t => (byTopic[t.id] || []).length > 0) : topics;

  const topicBlocks = visibleTopics.map((t) => {
    const topicItems = byTopic[t.id] || [];
    if (dropEmpty && topicItems.length === 0) return null;
    return (
      <TopicBlock
        key={t.id}
        pillarId={pillar.id}
        topic={t}
        items={topicItems}
        onOpen={onOpen}
        onVotes={onVotes}
        vote={vote}
      />
    );
  }).filter(Boolean);

  const orphanItems = topicFilter === 'all' ? orphans : [];

  return (
    <section id={pillar.id} className="ev-pillar-section">
      <header className="ev-section-head">
        <div className="ev-section-num">
          <span className="roman">{toRoman(index + 1)}</span>
          <span>Pillar {pillar.n} / {String(total).padStart(2, '0')}</span>
        </div>
        <div className="ev-section-main">
          {pillar.tag && <div className="ev-section-tag">{pillar.tag}</div>}
          <h2 className="ev-section-title">{pillar.title}</h2>
          {pillar.blurb && <p className="ev-section-blurb">{pillar.blurb}</p>}
          {chipTopics.length > 0 && (
            <div className="ev-topic-chiprow">
              <button className={`ev-topic-chip ${topicFilter === 'all' ? 'is-active' : ''}`} onClick={() => setTopicFilter('all')}>All topics</button>
              {chipTopics.map(t => (
                <button key={t.id} className={`ev-topic-chip ${topicFilter === t.id ? 'is-active' : ''}`} onClick={() => setTopicFilter(t.id)}>
                  {t.title}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="ev-section-meta">
          <b>{countedItems}</b>
          <span className="count-inline">entries</span>
        </div>
      </header>

      {topicBlocks}
      {orphanItems.length > 0 && (
        <TopicBlock pillarId={pillar.id} topic={{ id: '__orphan', title: 'Unclassified — awaiting topic', blurb: 'Evidence filed under this pillar but not yet assigned to a specific topic.' }} items={orphanItems} onOpen={onOpen} onVotes={onVotes} vote={vote} />
      )}
      {topicBlocks.length === 0 && orphanItems.length === 0 && (
        <div className="ev-empty ev-empty-topic">No entries match your filter in this pillar.</div>
      )}
    </section>
  );
}

// Flat results view for global search / tier filter.
function SearchResults({ q, tier, items, total, onOpen, onVotes, onClear }) {
  const tierLabel = tier === '1' ? 'I' : tier === '2' ? 'II' : tier === '3' ? 'III' : null;
  const n = total ?? items.length;
  return (
    <section className="ev-search-results">
      <div className="ev-search-head">
        <div>
          <span className="eyebrow ev-eyebrow">Search results</span>
          <h2 className="ev-search-title">
            {q ? <em>&ldquo;{q}&rdquo;</em> : 'Filtered view'}
            {tierLabel ? <> · Tier {tierLabel}</> : null}
          </h2>
          <p className="ev-search-sub">{n} result{n === 1 ? '' : 's'} · across all pillars</p>
        </div>
        <button className="ev-btn ev-btn-ghost" onClick={onClear}>← Back to structural view</button>
      </div>
      {items.length === 0 ? (
        <div className="ev-search-empty">
          <span className="eyebrow ev-eyebrow">Search · 0 results</span>
          <h3>Nothing on {q ? <em>&ldquo;{q}&rdquo;</em> : 'that filter'} yet.</h3>
          <p>No evidence matches across the archive. It is built by submission — be the first to file.</p>
          <button className="ev-btn ev-btn-ghost" onClick={onClear}>Clear search</button>
        </div>
      ) : (
        <div className="ev-grid">
          {items.map(e => <EvCard key={e.id} e={e} onOpen={onOpen} onVotes={onVotes} />)}
        </div>
      )}
    </section>
  );
}

function LoadingSkeleton() {
  return (
    <section className="ev-pillar-section">
      <header className="ev-section-head">
        <div className="ev-section-num"><span className="roman" style={{ opacity: 0.3 }}>···</span><span className="ev-skel" style={{ width: 90, height: 11 }} /></div>
        <div className="ev-section-main">
          <div className="ev-skel" style={{ width: 120, height: 10, marginBottom: 14 }} />
          <div className="ev-skel" style={{ width: '60%', height: 34, marginBottom: 12 }} />
          <div className="ev-skel" style={{ width: '40%', height: 14 }} />
        </div>
        <div className="ev-section-meta"><div className="ev-skel" style={{ width: 56, height: 26 }} /></div>
      </header>
      <div className="ev-topic-block">
        <div className="ev-topic-head"><span className="ev-t-no">···</span><div className="ev-skel" style={{ width: 200, height: 22 }} /></div>
        <div className="ev-grid ev-grid-flat">
          {Array.from({ length: 6 }, (_, i) => <div key={i} className="ev-skel ev-skel-card" />)}
        </div>
      </div>
    </section>
  );
}

function EmptyArchive({ contractAddr }) {
  const short = contractAddr ? `${contractAddr.slice(0, 4)}…${contractAddr.slice(-4)}` : '0x…';
  return (
    <div className="ev-archive-empty">
      <span className="eyebrow ev-eyebrow ev-eyebrow-plain">Brand new · 0 categories · 0 topics · 0 evidence</span>
      <h2>The archive begins where the first peer says <em>&ldquo;add it.&rdquo;</em></h2>
      <p>
        Nothing is pre-loaded — by design. Peers propose the first categories and topics;
        once the group agrees on a topic, evidence can be filed under it. Anyone can add evidence, but peers decide what enters the archive.
        You are watching the network&rsquo;s first day.
      </p>
      <div className="ev-archive-empty-cta">
        <a className="ev-btn ev-btn-primary" href="/peer-review/">Propose the first category in Peer Review →</a>
      </div>
      <div className="ev-archive-empty-meta">
        <span>Network · <b>BNB Chain</b></span>
        <span>Public record · <b>{short}</b></span>
      </div>
    </div>
  );
}

// One row of the per-evidence vote history. Mirrors the Home / Peer Review vote
// rows: an optional deliberation note expands beneath the row, and the proof
// cell reuses AttestationVerifier (client-side EIP-712 recovery + on-chain tx).
function VoteHistoryRow({ v, handleMap }) {
  const [showNote, setShowNote] = useState(false);
  const note = (v.note || '').trim();
  const peerName = v.peer_handle || handleMap[v.peer_addr?.toLowerCase()] || shortAddr(v.peer_addr);
  return (
    <div className={`ev-vote-row${showNote ? ' is-noted' : ''}`}>
      <span className="t">{timeAgo(v.created_at)}</span>
      <span className={`ev-vote-verdict ${verdictClass(v.verdict)}`}>{VERDICT_LABEL[v.verdict] || v.verdict}</span>
      <span className="ev-vote-peer" title={v.peer_addr}>
        {peerName}
        <CopyChip value={v.peer_addr} label="peer address" />
      </span>
      <span className="ev-vote-note-cell">
        {note ? (
          <button
            type="button"
            className={`ev-vote-note-btn ${showNote ? 'is-open' : ''}`}
            onClick={() => setShowNote(s => !s)}
            aria-expanded={showNote}
            title={showNote ? 'Hide deliberation note' : 'Show the peer’s deliberation note'}
          >
            <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
            Note
          </button>
        ) : (
          <span className="ev-vote-none">—</span>
        )}
      </span>
      <span className="ev-vote-proof"><AttestationVerifier a={v} handle={peerName} handleMap={handleMap} /></span>
      {note && showNote && (
        <div className="ev-vote-note">
          <span className="ev-vote-note-label">Deliberation note</span>
          <p>{note}</p>
        </div>
      )}
    </div>
  );
}

// Vote-history modal: every signed peer vote on one evidence record, across all
// the topics it is filed under. Public by design — it reads the open attestation
// log so anyone can see who voted, how, and independently verify each signature
// and on-chain transaction without connecting a wallet.
function VoteHistoryModal({ e, onClose }) {
  const { votes, loading } = useEvidenceVotes(e?.id);
  const handleMap = usePeerHandleMap();

  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!e) return null;

  const tally = votes.reduce((m, v) => { const k = verdictClass(v.verdict); m[k] = (m[k] || 0) + 1; return m; }, {});
  const tallyOrder = [['approve', 'Approved'], ['reject', 'Rejected'], ['challenge', 'Challenged'], ['defend', 'Defended']]
    .filter(([k]) => tally[k]);

  return (
    <div className="ev-modal-backdrop is-open" onClick={onClose}>
      <div className="ev-modal ev-votes-modal" onClick={(ev) => ev.stopPropagation()}>
        <button className="ev-modal-close" onClick={onClose} aria-label="Close">×</button>

        <div className="ev-detail-eyebrow"><span className="ev-type">Vote history</span></div>
        <h3 className="ev-detail-title">Who voted</h3>
        <p className="ev-detail-src">{e.title}</p>

        {!loading && votes.length > 0 && (
          <div className="ev-votes-tally">
            {tallyOrder.map(([k, label]) => (
              <span key={k} className={`ev-votes-tally-chip ${k}`}>{tally[k]} {label}</span>
            ))}
          </div>
        )}

        <div className="ev-votes-list">
          {loading ? (
            <div className="ev-votes-state">Loading signed votes…</div>
          ) : votes.length === 0 ? (
            <div className="ev-votes-state">No signed peer votes recorded for this evidence yet.</div>
          ) : (
            <>
              <div className="ev-vote-row is-head"><span>When</span><span>Verdict</span><span>Peer</span><span>Note</span><span>Proof</span></div>
              {votes.map(v => <VoteHistoryRow key={v.id} v={v} handleMap={handleMap} />)}
            </>
          )}
        </div>

        <p className="ev-modal-id" title={`Evidence id · ${e.id}`}>
          <span className="ev-modal-id-label">ID</span>
          <span className="ev-modal-id-value">{e.id}</span>
          <CopyChip value={e.id} label="evidence id" />
        </p>
      </div>
    </div>
  );
}

function DetailModal({ e, onClose, walletPeer, vote }) {
  const [challengeOpen, setChallengeOpen] = useState(false);
  const [challengeReason, setChallengeReason] = useState('');
  const [challenging, setChallenging] = useState(false);
  const [challenged, setChallenged] = useState(false);
  const [chainWarning, setChainWarning] = useState(null);

  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    setChallengeOpen(false);
    setChallengeReason('');
    setChallenged(false);
  }, [e?.id]);

  if (!e) return null;

  const isCanon = e.status === 'canon' || e.status === 'approved' || e.status === 'reaffirmed';
  const isQueued = e.status === 'queued';

  const handleChallenge = async (ev) => {
    ev.preventDefault();
    if (!walletPeer?.addr || !walletPeer?.isPeer) return;
    if (challengeReason.trim().length === 0) return;
    setChallenging(true);
    setChainWarning(null);

    // Opening a challenge is a by-signature vote: the EIP-712 `Vote` signature is
    // mandatory and IS the on-chain authorization (the contract recovers it). In
    // dev mode (no contract) we still sign a Vote so the off-chain row is proven.
    const reason    = challengeReason.trim();
    const topicHash = await slugToBytes32(e.topicId);
    let sig, txHash = null, round = null, noteHash = null, bindingHash = null;
    try {
      if (CONSENSUS_ADDR) {
        ({ txHash, sig, noteHash, round, bindingHash } = await openChallengeOnChain(e.id, topicHash, reason));
        try { await waitForTx(txHash); }
        catch (txErr) {
          setChainWarning('Transaction reverted — challenge not recorded.');
          setChallenging(false);
          return;
        }
      } else {
        ({ sig, noteHash, round, bindingHash } = await signVoteOnly(e.id, topicHash, 1, true, reason));
      }
    } catch (err) {
      setChainWarning(err?.code === 4001 || err?.message?.includes('rejected')
        ? 'Signature/transaction rejected — challenge not filed.'
        : `Challenge failed — ${err?.message || 'unknown error'}`);
      setChallenging(false);
      return;
    }

    try {
      await openChallenge(e, walletPeer.addr, walletPeer.handle || '', reason, sig, txHash, undefined, { round, noteHash, bindingHash });
    } catch (syncErr) {
      // On-chain succeeded; cache will catch up via indexer.
    }
    setChallenging(false);
    setChallenged(true);
  };

  return (
    <div className="ev-modal-backdrop is-open" onClick={onClose}>
      <div className="ev-modal" onClick={(ev) => ev.stopPropagation()}>
        <button className="ev-modal-close" onClick={onClose} aria-label="Close">×</button>

        <EvidenceDetailBody e={e} statusLabel={isQueued ? 'Awaiting review' : undefined} />

        {/* Vote section — only for queued evidence awaiting a review slot */}
        {isQueued && vote && (
          <div className="ev-challenge-section ev-vote-section">
            <div className="ev-challenge-form-label">Move up the review line</div>
            <p className="ev-challenge-form-sub">
              Anyone signed in can cast one vote to move this evidence up the review line.
              A short wait between votes keeps it fair — peers look at the most-voted evidence first. Votes set the order, not the outcome.
            </p>
            <button
              className="ev-challenge-trigger"
              disabled={vote.busy === e.bindingId || vote.cooldownLeft > 0}
              onClick={() => vote.boost(e)}
            >
              {vote.busy === e.bindingId ? 'Voting…' : vote.cooldownLeft > 0 ? `⏳ Cooldown · ${fmtCooldown(vote.cooldownLeft)}` : `✦ Vote to promote · ${vote.votesFor(e)}`}
            </button>
            {vote.err && (
              <p style={{ marginTop: 8, fontSize: 11, fontFamily: 'var(--mono)', letterSpacing: '0.08em', color: 'var(--warn)' }}>⚠ {vote.err}</p>
            )}
          </div>
        )}

        {/* Challenge section — only for canon / reaffirmed evidence */}
        {isCanon && !challenged && (
          <div className="ev-challenge-section">
            {!walletPeer?.isPeer ? (
              <p style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em', color: 'var(--ink-faint)', margin: 0 }}>
                <a href="/peer-review/" style={{ color: 'var(--accent-2)' }}>Sign in as a verified peer →</a>
                {' '}to contest this evidence.
              </p>
            ) : walletPeer.cooldownSecs > 0 ? (
              <p style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em', color: 'var(--warn)', margin: 0 }}>
                Cooldown active — next available in{' '}
                {Math.ceil(walletPeer.cooldownSecs / 86400)} day{Math.ceil(walletPeer.cooldownSecs / 86400) === 1 ? '' : 's'}{' '}
                ({new Date(Date.now() + walletPeer.cooldownSecs * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}).
              </p>
            ) : !challengeOpen ? (
              <button className="ev-challenge-trigger" onClick={() => setChallengeOpen(true)}>
                Challenge this evidence
              </button>
            ) : (
              <form className="ev-challenge-form" onSubmit={handleChallenge}>
                <div className="ev-challenge-form-label">State your reasons</div>
                <p className="ev-challenge-form-sub">
                  What specific claim is wrong, misleading, or no longer holds up?
                  Other peers will vote to remove it or keep it.
                </p>
                <textarea
                  autoFocus
                  value={challengeReason}
                  onChange={ev => setChallengeReason(ev.target.value)}
                  placeholder="E.g. 'This study was retracted' or 'The quote is out of context'"
                  rows={4}
                />
                <div className="ev-challenge-form-foot">
                  <button type="button" className="ev-challenge-cancel" onClick={() => { setChallengeOpen(false); setChallengeReason(''); }}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="ev-challenge-submit"
                    disabled={challengeReason.trim().length === 0 || challenging}
                  >
                    {challenging ? 'Filing…' : 'File challenge →'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        {challenged && (
          <div className="ev-challenge-section ev-challenge-filed">
            Challenge filed. Peers will vote on it in{' '}
            <a href="/peer-review/">Peer Review →</a>
            {chainWarning && (
              <p style={{ marginTop: 8, fontSize: 11, fontFamily: 'var(--mono)', letterSpacing: '0.08em', color: 'var(--warn)', opacity: 0.85 }}>
                ⚠ {chainWarning}
              </p>
            )}
          </div>
        )}

        <p className="ev-modal-id" title={`Evidence id · ${e.id}`}>
          <span className="ev-modal-id-label">ID</span>
          <span className="ev-modal-id-value">{e.id}</span>
          <CopyChip value={e.id} label="evidence id" />
        </p>
      </div>
    </div>
  );
}

function SubmitModal({ open, onClose, walletPeer, pillars }) {
  const [form, setForm] = useState({
    pillar: '', topic: '', type: 'Paper', tier: 2,
    title: '', source: '', year: '', excerpt: '', link: '', tags: '',
  });
  // The (pillar × topic) bindings this evidence will be filed under. Each is an
  // independent review unit on-chain. Starts with one; peers can add more.
  const [filings, setFilings] = useState([]);   // [{ pillar, topic }]
  const [sent, setSent]             = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [newId, setNewId]           = useState(null);  // UUID of the inserted evidence
  const [newBindings, setNewBindings] = useState([]); // [{ id, topicId, bindingId }]
  const [newPayload, setNewPayload] = useState(null);  // content snapshot used for the on-chain hash
  const [doneCount, setDoneCount]   = useState(0);     // bindings already confirmed on-chain

  // Default the pillar/topic selects once the taxonomy loads (or changes).
  useEffect(() => {
    if (!pillars.length) return;
    setForm(f => {
      const pillar = pillars.find(p => p.id === f.pillar) || pillars[0];
      const topics = pillar.topics || [];
      const topic  = topics.find(t => t.id === f.topic) || topics[0];
      return { ...f, pillar: pillar.id, topic: topic?.id || '' };
    });
  }, [pillars]);

  useEffect(() => {
    if (open) {
      setSent(false);
      setSubmitError(null);
      setNewId(null);
      setNewBindings([]);
      setNewPayload(null);
      setDoneCount(0);
      setForm(f => ({ ...f, title: '', source: '', year: '', excerpt: '', link: '', tags: '' }));
      // Seed one filing from the current/default pillar+topic.
      const p = pillars.find(x => x.id === form.pillar) || pillars[0];
      const t = (p?.topics || []).find(x => x.id === form.topic) || p?.topics?.[0];
      setFilings(p && t ? [{ pillar: p.id, topic: t.id }] : []);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handle = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  // Changing pillar resets the topic to that pillar's first topic.
  const onPillarChange = (e) => {
    const pillar = pillars.find(p => p.id === e.target.value);
    setForm(f => ({ ...f, pillar: e.target.value, topic: pillar?.topics?.[0]?.id || '' }));
  };

  const activePillar = pillars.find(p => p.id === form.pillar);
  const topicOptions = activePillar?.topics || [];
  // Once the off-chain row is saved, lock the content so a retried signature
  // keeps hashing the exact saved payload.
  const locked = submitting || !!newId;

  const pillarOf = (pid) => pillars.find(p => p.id === pid) || {};
  const topicTitleOf = (pid, tid) => (pillarOf(pid).topics || []).find(t => t.id === tid)?.title || tid;

  const addFiling = () => {
    if (!form.pillar || !form.topic) return;
    setFilings(fs => fs.some(f => f.pillar === form.pillar && f.topic === form.topic)
      ? fs
      : [...fs, { pillar: form.pillar, topic: form.topic }]);
  };
  const removeFiling = (i) => setFilings(fs => fs.filter((_, idx) => idx !== i));

  // Register the off-chain rows on-chain — the submitter signs every tx itself.
  // `payload` is the content snapshot taken at insert time so the on-chain hash
  // always matches the saved row even if the form is edited afterward. Resumes
  // from `doneCount` so a rejected signature can be retried without
  // re-registering bindings that already confirmed.
  const registerOnChain = async (evId, bindings, payload) => {
    let addr = walletPeer?.addr;
    if (!addr) ({ addr } = await connectWallet());
    await switchToTargetChain();

    const contentHash = await computeContentHash(payload);
    for (let i = doneCount; i < bindings.length; i++) {
      const b = bindings[i];
      const topicId = await slugToBytes32(b.topicId);
      const txHash = i === 0
        ? await submitEvidenceOnChain(evId, payload.tier, topicId, contentHash)
        : await fileBindingOnChain(evId, topicId);
      await waitForTx(txHash);
      try { await markBindingOnchain(b, addr, txHash); } catch { /* non-peer: indexer reconciles */ }
      setDoneCount(i + 1);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    const list = filings.length
      ? filings
      : (form.pillar && form.topic ? [{ pillar: form.pillar, topic: form.topic }] : []);
    if (!form.title.trim() || list.length === 0) return;
    if (!CONSENSUS_ADDR)   { setSubmitError('Saving to the public record isn’t set up here yet.'); return; }
    if (!window.ethereum)  { setSubmitError('A secure crypto wallet (like MetaMask) is needed to approve your submission.'); return; }
    setSubmitting(true);
    setSubmitError(null);

    // Insert the off-chain content once (anon insert; service-side promotion
    // flips submitted_onchain). Reuse the saved id when retrying a signature.
    let evId    = newId;
    let created = newBindings;
    let payload = newPayload;
    if (!evId) {
      const tags = form.tags.split(',').map(s => s.trim()).filter(Boolean);
      const { data: inserted, error } = await supabase.from('evidence').insert({
        type:      form.type,
        tier:      Number(form.tier),
        title:     form.title.trim(),
        source:    form.source.trim() || null,
        year:      form.year.trim() || null,
        excerpt:   form.excerpt.trim() || null,
        link:      form.link.trim() || null,
        tags,
        status:    'pending',
      }).select('id').single();
      if (error) { setSubmitting(false); setSubmitError(error.message); return; }
      evId = inserted?.id;
      // File one binding per chosen (pillar × topic) — each votes independently.
      created = [];
      for (const f of list) {
        const bindingHash = await bindingKey(evId, await slugToBytes32(f.topic));
        const { data: b, error: bErr } = await supabase.from('bindings').insert({
          evidence_id: evId, pillar_id: f.pillar, topic_id: f.topic,
          binding_hash: bindingHash, status: 'pending', submitted_onchain: false,
        }).select('id').single();
        if (bErr) { setSubmitting(false); setSubmitError(bErr.message); return; }
        created.push({ id: evId, topicId: f.topic, bindingId: b?.id || null });
      }
      payload = {
        title:   form.title.trim(),
        source:  form.source.trim() || null,
        year:    form.year.trim()   || null,
        excerpt: form.excerpt.trim() || null,
        link:    form.link.trim()   || null,
        tier:    Number(form.tier),
      };
      setNewId(evId);
      setNewBindings(created);
      setNewPayload(payload);
    }

    // Mandatory signature: the submitter signs the on-chain registration itself.
    try {
      await registerOnChain(evId, created, payload);
    } catch (err) {
      setSubmitting(false);
      const rejected = err?.code === 4001 || /reject|denied/i.test(err?.message || '');
      setSubmitError(rejected
        ? 'Approval cancelled — your submission is saved. Approve it to enter the review line.'
        : `Couldn’t save to the public record — ${err?.message || 'unknown error'}`);
      return;
    }

    setSubmitting(false);
    setSent(true);
    fireConfetti();
  };

  if (!open) return null;
  return (
    <div className="ev-modal-backdrop is-open" onClick={onClose}>
      <div className="ev-modal" onClick={(ev) => ev.stopPropagation()}>
        <button className="ev-modal-close" onClick={onClose} aria-label="Close">×</button>
        {sent ? (
          <div className="ev-form-success">
            <div className="check">✓</div>
            <h3 className="ev-detail-title" style={{ textAlign: 'center' }}>Filed &amp; signed.</h3>
            <p className="lead" style={{ textAlign: 'center', marginTop: 12 }}>
              Your submission is signed and saved to the public record — it&rsquo;s
              now in line for peers to review and vote on.
            </p>
            <p style={{ textAlign: 'center', marginTop: 12, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-faint)' }}>
              {newBindings.length > 1
                ? `${newBindings.length} filings saved to the public record.`
                : 'Saved to the public record.'}
            </p>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="ev-detail-eyebrow">
              <span className="ev-type">SUBMIT</span>
            </div>
            <h3 className="ev-detail-title">Add to the archive</h3>
            <p className="ev-detail-src">Anyone can add evidence — you approve the submission with your own secure key. Peers then review it and vote to accept or turn it down.</p>

            <div className="ev-form-grid" style={{ marginTop: 12 }}>
              <div className="ev-form-row">
                <label htmlFor="f-pillar">Category</label>
                <select id="f-pillar" value={form.pillar} onChange={onPillarChange} disabled={locked}>
                  {pillars.map(p => <option key={p.id} value={p.id}>{p.n} · {p.title}</option>)}
                </select>
              </div>
              <div className="ev-form-row">
                <label htmlFor="f-topic">Topic</label>
                <div className="ev-topic-add">
                  <select id="f-topic" value={form.topic} onChange={handle('topic')} disabled={locked}>
                    {topicOptions.length === 0
                      ? <option value="">No topics yet</option>
                      : topicOptions.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                  </select>
                  <button type="button" className="ev-filing-add" onClick={addFiling} disabled={locked || !form.topic}
                    title="File under another pillar/topic">+ Add</button>
                </div>
              </div>
            </div>

            {filings.length > 0 && (
              <div className="ev-filings" style={{ marginTop: 4 }}>
                {filings.map((f, i) => (
                  <span className="ev-filing-chip" key={`${f.pillar}:${f.topic}`}>
                    <span className="pn">{pillarOf(f.pillar).n}</span>
                    <span className="tt">{topicTitleOf(f.pillar, f.topic)}</span>
                    <button type="button" onClick={() => removeFiling(i)} aria-label="Remove filing" disabled={locked}>×</button>
                  </span>
                ))}
              </div>
            )}

            <div className="ev-form-row">
              <label htmlFor="f-type">Type</label>
              <select id="f-type" value={form.type} onChange={handle('type')} disabled={locked}>
                {['Paper','Book','Podcast','Documentary','Video','Declassified','Testimony','Lecture','Study','Method','Investigation','Witness','Art','Photograph','Document'].map(t =>
                  <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            <div className="ev-form-row">
              <label>Tier</label>
              <div className="ev-form-radio-row">
                {[{ v: 1, label: 'I — Peer-reviewed' }, { v: 2, label: 'II — Documented' }, { v: 3, label: 'III — Testimony' }].map(t => (
                  <button type="button" key={t.v}
                    className={`ev-form-radio ${Number(form.tier) === t.v ? 'is-active' : ''}`}
                    onClick={() => setForm({ ...form, tier: t.v })}
                    disabled={locked}
                  >{t.label}</button>
                ))}
              </div>
            </div>

            <div className="ev-form-row">
              <label htmlFor="f-title">Title</label>
              <input id="f-title" value={form.title} onChange={handle('title')} required placeholder="e.g. The Tao of Physics" disabled={locked} />
            </div>

            <div className="ev-form-grid">
              <div className="ev-form-row">
                <label htmlFor="f-source">Source / author</label>
                <input id="f-source" value={form.source} onChange={handle('source')} placeholder="Fritjof Capra · Shambhala" disabled={locked} />
              </div>
              <div className="ev-form-row">
                <label htmlFor="f-year">Year</label>
                <input id="f-year" value={form.year} onChange={handle('year')} placeholder="1975" disabled={locked} />
              </div>
            </div>

            <div className="ev-form-row">
              <label htmlFor="f-excerpt">Excerpt (why it matters)</label>
              <textarea id="f-excerpt" value={form.excerpt} onChange={handle('excerpt')} placeholder="One or two sentences on why this evidence belongs here…" disabled={locked} />
            </div>

            <div className="ev-form-grid">
              <div className="ev-form-row">
                <label htmlFor="f-link">Source URL</label>
                <input id="f-link" value={form.link} onChange={handle('link')} placeholder="https://…" disabled={locked} />
              </div>
              <div className="ev-form-row">
                <label htmlFor="f-tags">Tags (comma-separated)</label>
                <input id="f-tags" value={form.tags} onChange={handle('tags')} placeholder="quantum, mysticism, capra" disabled={locked} />
              </div>
            </div>

            <div className="ev-form-foot">
              <p className="ev-form-hint">
                {submitError
                  ? <span style={{ color: 'var(--accent-ink)' }}>{submitError}</span>
                  : 'You approve each filing with your secure key — peers then review it for relevance.'}
              </p>
              <button type="submit" className="ev-form-submit" disabled={submitting}>
                {submitting
                  ? 'Approving…'
                  : newId
                    ? 'Approve submission →'
                    : `Approve & add evidence${(filings.length || 1) > 1 ? ` · ${filings.length} filings` : ''} →`}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default function Evidence() {
  const [q, setQ] = useState('');
  const [tier, setTier] = useState('all');
  const [open, setOpen] = useState(null);
  const [votesOpen, setVotesOpen] = useState(null); // evidence whose vote history is shown
  const [submitOpen, setSubmitOpen] = useState(false);
  const [activePillar, setActivePillar] = useState('');
  const [mode, setMode] = useState('archive'); // 'archive' | 'vote'

  const tax = useTaxonomy();
  const pillars = tax.pillars;

  // Minimal wallet state for challenge gating — full peer auth lives in PeerReview
  const [walletPeer, setWalletPeer] = useState(null); // { addr, handle, isPeer }

  // Vote mode: anyone boosts queued bindings up the peer-review queue. The boost
  // hook needs the connected wallet to read its on-chain cooldown; peers are
  // exempt from the cooldown so we pass isPeer through.
  const voteBundle = useBoost(walletPeer?.addr, !!walletPeer?.isPeer);
  const { queue: queued, loading: queuedLoading } = useQueuedBindings();

  // Silent wallet check on load; recheck whenever the connected account changes.
  useEffect(() => {
    if (!window.ethereum || !CONSENSUS_ADDR) return;

    const checkAccount = async (addr) => {
      if (!addr) { setWalletPeer(null); return; }
      const peer         = await isPeerActive(addr);
      const handle       = peer ? await getPeerHandle(addr) : '';
      const cooldownSecs = peer ? await getChallengeCooldownRemaining(addr) : 0;
      setWalletPeer({ addr, handle, isPeer: peer, cooldownSecs });
    };

    window.ethereum.request({ method: 'eth_accounts' })
      .then(accounts => checkAccount(accounts[0] || null))
      .catch(() => {});

    const onAccountsChanged = (accounts) => checkAccount(accounts[0] || null);
    window.ethereum.on('accountsChanged', onAccountsChanged);
    return () => window.ethereum.removeListener?.('accountsChanged', onAccountsChanged);
  }, []);

  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const { evidence, loading, total, hasMore, loadMore } = useEvidence(debouncedQ, tier);
  const tierCounts = useTierCounts();

  // A text search switches to the flat results list; otherwise we keep the
  // structural Pillar → Topic view — a tier filter narrows that tree in place
  // rather than flattening it. Tier-filtered rows arrive un-paginated, so
  // empty pillars/topics are dropped to keep the filtered structure tight.
  const structural = !debouncedQ;
  const tierFiltered = tier !== 'all';
  const tierLabel = tier === '1' ? 'I' : tier === '2' ? 'II' : tier === '3' ? 'III' : null;
  const structuralPillars = useMemo(
    () => (tierFiltered ? pillars.filter(p => evidence.some(e => e.pillarId === p.id)) : pillars),
    [pillars, evidence, tierFiltered],
  );

  // Vote mode: client-filter the queued pool by tier + search, then keep only
  // the pillars that still hold votable evidence (taxonomy stays, empties drop).
  const queuedFiltered = useMemo(() => {
    const ql = debouncedQ.toLowerCase();
    return queued.filter(e => {
      if (tier !== 'all' && String(e.tier) !== tier) return false;
      if (!ql) return true;
      return [e.title, e.source, e.excerpt, e.pillarTitle, e.topicTitle].some(s => (s || '').toLowerCase().includes(ql));
    });
  }, [queued, tier, debouncedQ]);
  const votePillars = useMemo(() => {
    const ids = new Set(queuedFiltered.map(e => e.pillarId));
    return pillars.filter(p => ids.has(p.id));
  }, [pillars, queuedFiltered]);
  const voteCounts = useMemo(() => {
    const m = {};
    for (const e of queuedFiltered) m[e.pillarId] = (m[e.pillarId] || 0) + 1;
    return m;
  }, [queuedFiltered]);

  // Per-pillar live counts (non-deprecated) for the pillar picker.
  const pillarCounts = useMemo(() => {
    const m = {};
    for (const e of evidence) if (e.status !== 'deprecated') m[e.pillarId] = (m[e.pillarId] || 0) + 1;
    return m;
  }, [evidence]);

  const jumpToPillar = (id) =>
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // Seed the active pillar (for the picker) once the taxonomy loads.
  useEffect(() => {
    if (!activePillar && pillars.length) setActivePillar(pillars[0].id);
  }, [pillars, activePillar]);

  useEffect(() => {
    const onScroll = () => {
      if (!pillars.length) return;
      const y = window.scrollY + 200;
      let cur = pillars[0].id;
      for (const p of pillars) {
        const el = document.getElementById(p.id);
        if (el && el.offsetTop <= y) cur = p.id;
      }
      setActivePillar(cur);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, [pillars]);

  useEffect(() => {
    document.body.style.overflow = (!!open || !!votesOpen || submitOpen) ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open, votesOpen, submitOpen]);

  // Scroll to hash once the archive has rendered. Wait for evidence to load
  // so the target pillar section exists in the DOM before scrolling.
  // For `#ev-<uuid>` hashes we additionally open the evidence modal — if the
  // row isn't in the current paginated list, fall back to a direct fetch so
  // deep-links from the chain log still surface the source.
  const hashScrolledRef = useRef(false);
  useEffect(() => {
    if (hashScrolledRef.current) return;
    if (loading || !window.location.hash) return;
    const hashId = window.location.hash.slice(1);
    hashScrolledRef.current = true;

    if (hashId.startsWith('ev-')) {
      const evId   = hashId.slice(3);
      const loaded = evidence.find(it => it.id === evId);
      const el     = document.getElementById(hashId);
      if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      if (loaded) {
        setOpen(loaded);
      } else {
        supabase.from('evidence').select('*').eq('id', evId).maybeSingle()
          .then(({ data }) => { if (data) setOpen(data); });
      }
      return;
    }

    const el = document.getElementById(hashId);
    if (!el) return;
    requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [loading, evidence]);

  const vote = voteBundle;

  return (
    <div className="ev-shell">
      <Nav />
      <Hero counts={tierCounts} contractAddr={CONSENSUS_ADDR} />
      <TierStrip counts={tierCounts} />

      <Shelf
        q={q} setQ={setQ}
        tier={tier} setTier={setTier}
        structural={structural}
        pillars={mode === 'vote' ? votePillars : structuralPillars}
        counts={mode === 'vote' ? voteCounts : pillarCounts}
        activePillar={activePillar}
        onJump={jumpToPillar}
        onSubmit={() => setSubmitOpen(true)}
        mode={mode} setMode={setMode}
      />

      <main className="ev-main">
        {mode === 'vote' ? (
          !tax.loaded || (queuedLoading && queued.length === 0) ? (
            <LoadingSkeleton />
          ) : votePillars.length === 0 ? (
            <div className="ev-archive-empty">
              <span className="eyebrow ev-eyebrow ev-eyebrow-plain">Vote · move evidence up the review line</span>
              <h2>{queued.length === 0
                ? <>Nothing is awaiting your <em>vote</em> right now.</>
                : <>No waiting evidence matches your filter.</>}</h2>
              <p>{queued.length === 0
                ? 'When evidence is submitted it waits here for review. Cast a vote to move the evidence you most want looked at to the front of the line.'
                : 'Try a different search term or tier filter.'}</p>
            </div>
          ) : (
            <>
              <div className="ev-vote-intro">
                <span className="eyebrow ev-eyebrow">Vote · {queuedFiltered.length} awaiting review</span>
                <p>Cast one vote per item to move it up the review line. Anyone signed in can vote — one vote per item, with a short wait between votes to keep it fair. Peers look at the most-voted evidence first; votes set the order, never the outcome.</p>
                {vote.err && <p className="ev-queue-err">{vote.err}</p>}
              </div>
              {votePillars.map((p, i) => (
                <PillarSection
                  key={p.id}
                  pillar={p}
                  index={i}
                  total={votePillars.length}
                  items={queuedFiltered.filter(e => e.pillarId === p.id)}
                  onOpen={setOpen}
                  vote={vote}
                  voteMode
                />
              ))}
            </>
          )
        ) : (loading && evidence.length === 0) || !tax.loaded ? (
          <LoadingSkeleton />
        ) : pillars.length === 0 ? (
          <EmptyArchive contractAddr={CONSENSUS_ADDR} />
        ) : structural ? (
          <>
            {tierFiltered && (
              <div className="ev-search-head ev-tier-head">
                <div>
                  <span className="eyebrow ev-eyebrow">Filtered by tier</span>
                  <h2 className="ev-search-title">Tier {tierLabel}</h2>
                  <p className="ev-search-sub">
                    {evidence.length} entr{evidence.length === 1 ? 'y' : 'ies'} · {structuralPillars.length} pillar{structuralPillars.length === 1 ? '' : 's'} · taxonomy preserved
                  </p>
                </div>
                <button className="ev-btn ev-btn-ghost" onClick={() => setTier('all')}>← All tiers</button>
              </div>
            )}
            {tierFiltered && structuralPillars.length === 0 ? (
              <div className="ev-archive-empty">
                <span className="eyebrow ev-eyebrow ev-eyebrow-plain">Tier {tierLabel} · 0 entries</span>
                <h2>Nothing at <em>Tier {tierLabel}</em> yet.</h2>
                <p>No evidence matches this tier across the archive. Try another tier or clear the filter.</p>
                <div className="ev-archive-empty-cta">
                  <button className="ev-btn ev-btn-ghost" onClick={() => setTier('all')}>Clear tier filter</button>
                </div>
              </div>
            ) : (
              structuralPillars.map((p, i) => (
                <PillarSection
                  key={p.id}
                  pillar={p}
                  index={i}
                  total={structuralPillars.length}
                  items={evidence.filter(e => e.pillarId === p.id)}
                  onOpen={setOpen}
                  onVotes={setVotesOpen}
                  hideEmpty={tierFiltered}
                />
              ))
            )}
          </>
        ) : (
          <SearchResults
            q={debouncedQ}
            tier={tier}
            items={evidence}
            total={total}
            onOpen={setOpen}
            onVotes={setVotesOpen}
            onClear={() => { setQ(''); setTier('all'); }}
          />
        )}

        {mode === 'archive' && hasMore && (
          <div className="ev-loadmore">
            <button className="ev-btn ev-btn-ghost" onClick={loadMore} disabled={loading}>
              {loading ? 'Loading…' : `Load more · ${evidence.length} / ${total ?? evidence.length} shown`}
            </button>
          </div>
        )}
      </main>

      <DetailModal e={open} onClose={() => setOpen(null)} walletPeer={walletPeer} vote={vote} />
      <VoteHistoryModal e={votesOpen} onClose={() => setVotesOpen(null)} />
      <SubmitModal
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        walletPeer={walletPeer}
        pillars={pillars}
      />
    </div>
  );
}
