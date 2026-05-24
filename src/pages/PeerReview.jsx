/**
 * Peer Review — the verified-peer workspace.
 *
 * Wallet-gated. The review unit is an (evidence × pillar → topic) BINDING: one
 * evidence is filed under any number of topics, and each binding votes alone.
 * Only bindings that pass review enter the public archive; the rest stay
 * on-chain as rejected. Tabs: Review queue · Challenges · Attestation log ·
 * Taxonomy governance · Peer registry — all sharing the same pillar grammar.
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { supabase } from '../lib/supabase';
import Element115 from '../components/Element115';
import CopyChip from '../components/CopyChip';
import AttestationVerifier from '../components/AttestationVerifier';
import EvidenceDetailBody from '../components/EvidenceDetailBody';
import {
  useTaxonomy, usePendingTaxonomy,
  deprecateThreshold,
  PENDING_WINDOW_DAYS, CHALLENGE_WINDOW_DAYS, daysRemaining,
  usePendingBindings, useContestedBindings, useAttestationLog,
  useQueuedBindings, useMyReviewCount, usePeerHandleMap, fetchBindingPreview,
  useSystemHealth, useTamperAlertCount,
  castReviewVote, castChallengeVote, finalizeChallengeSupabase,
  proposeTaxonomyBundle, endorseNodeSupabase, rejectNodeSupabase, fetchMyTaxonomyRejects,
} from '../evidence-data';
import {
  connectWallet, switchToTargetChain, getActivePeerCount, getPeerHandle, isPeerActive,
  isGenesisPeer, getSeedPhaseK,
  endorseNominee as endorseNomineeOnChain,
  motionRevoke as motionRevokeOnChain,
  voteRevoke as voteRevokeOnChain,
  heartbeatOnChain, pruneInactivePeerOnChain, getLastActive,
  getReviewCapacity, getActiveReviewCount, promoteOnChain,
  castReviewVoteOnChain, castChallengeVoteOnChain,
  finalizeChallengeOnChain, markLapsedOnChain,
  waitForTx,
  nominatePeer as nominatePeerOnChain,
  hasEndorsedNominee,
  hasVotedManyOnChain, hasVotedForRevokeMany,
  signAttestation, CONSENSUS_ADDR,
  getChallengeCooldownRemaining,
  getActivePeersAggregated, getNomineesAggregated,
  computeContentHash, computeMetaHash,
  getProposedNodesAggregated, hasEndorsedNode, getTaxonomyThreshold,
  endorseNodeOnChain, proposePillarOnChain, proposeTopicOnChain, slugToBytes32, bindingKey,
  getRetireThreshold, isRetireActive, getRetireVoteCount, getRetireMotionAt, hasVotedForRetire,
  motionRetireNodeOnChain, voteRetireNodeOnChain, cancelStaleRetireOnChain,
  prefetchWallet,
} from '../lib/wallet';
import { cachedAddr, cacheAddr, cachedHandle, cacheHandle, cachedPeer, cachePeer } from '../lib/wallet-cache';
import metamaskFox from '../assets/metamask-fox.svg';
import '../styles/shared.css';
import '../styles/peer-review.css';
import '../styles/evidence.css';

// ── Helpers ──────────────────────────────────────────────────────────────────
const SHORT  = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const ROMAN  = ['', 'I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII','XIII','XIV','XV','XVI','XVII','XVIII','XIX','XX'];
const toRoman = (n) => ROMAN[n] || String(n);
const tierRoman = (t) => (t === 1 ? 'I' : t === 2 ? 'II' : 'III');
const tierWord  = (t) => (t === 1 ? 'Paper' : t === 2 ? 'Doc.' : 'Test.');
const SIG_ACTIONS = new Set(['review_vote', 'open_challenge', 'challenge_vote']);
// Verdict → human label + colour for the sign modal (approve/defend green,
// reject/challenge red).
const VERDICT_STYLE = {
  approve:   { label: 'Approve',           color: 'var(--ok)' },
  reject:    { label: 'Reject',            color: 'var(--danger)' },
  challenge: { label: 'Support challenge', color: 'var(--danger)' },
  defend:    { label: 'Defend evidence',   color: 'var(--ok)' },
};

function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function jazzGradient(addr = '0x0') {
  const h = hashStr(String(addr).toLowerCase());
  const a = h % 360, b = (h >> 3) % 360, c = (h >> 6) % 360;
  return `conic-gradient(from ${h % 360}deg, oklch(0.72 0.14 ${a}), oklch(0.72 0.14 ${b}), oklch(0.72 0.14 ${c}), oklch(0.72 0.14 ${a}))`;
}
const Jazz = ({ addr, size = 22 }) => (
  <span className="jazz" style={{ width: size, height: size, borderRadius: '50%', background: jazzGradient(addr), flexShrink: 0 }} />
);

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// Bindings whose review/challenge is settled (no longer "voting"/"contested").
const ARCHIVED = new Set(['canon', 'approved', 'reaffirmed']);
const REJECTED = new Set(['expelled', 'rejected', 'deprecated', 'lapsed']);

const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
const metamaskDeepLink = () => `https://metamask.app.link/dapp/${window.location.host}${window.location.pathname}`;

// ── Nav ──────────────────────────────────────────────────────────────────────
function Nav({ wallet, handle, onConnect, onDisconnect, connecting }) {
  return (
    <nav className="nav">
      <div className="nav-inner">
        <a href="/" className="brand">
          <span className="brand-text">The Disclosure Platform<small>Peer Review · Verified peers only</small></span>
        </a>
        <div className="nav-links">
          <a href="/">Home</a>
          <a href="/evidence/">Evidence</a>
          <a href="/peer-review/" className="is-active">Peer Review</a>
        </div>
        <div className="nav-right">
          {wallet ? (
            <button className="btn btn--ghost btn--sm" onClick={onDisconnect}>
              <Jazz addr={wallet} size={16} /> {handle || SHORT(wallet)}
            </button>
          ) : (
            <button className="btn btn--primary btn--sm" onClick={onConnect} disabled={connecting}>
              <img className="wallet-icon" src={metamaskFox} alt="" width="14" height="14" />
              {connecting ? 'Connecting…' : 'Connect wallet'}
            </button>
          )}
        </div>
      </div>
    </nav>
  );
}

// ── Connect / unverified screen ──────────────────────────────────────────────
function fmtCount(n) {
  if (n == null) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function ConnectScreen({ onConnect, onObserve, connecting, peerCount }) {
  const [nominees, setNominees] = useState(null);
  const [attestations, setAttestations] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getNomineesAggregated().then(n => { if (!cancelled) setNominees(n.length); });
    supabase.from('attestations').select('*', { count: 'exact', head: true })
      .then(({ count }) => { if (!cancelled) setAttestations(count ?? 0); });
    return () => { cancelled = true; };
  }, []);

  const stats = [
    { v: peerCount ?? '—',         lab: 'Verified peers' },
    { v: nominees ?? '—',          lab: 'In nomination' },
    { v: fmtCount(attestations),   lab: 'Attestations' },
  ];
  return (
    <div className="pr-connect">
      <div className="pr-connect-lead">
        <span className="eyebrow">Peer Review · Named peers verify the record</span>
        <h1 className="display" style={{ marginTop: 24 }}>A named<br />peer network<br /><em>signs the record.</em></h1>
        <p className="lead" style={{ maxWidth: '50ch', marginTop: 24 }}>
          Verified peers review evidence submissions, challenge decisions, and grow the taxonomy through consensus.
          Peers are wallet-signed, identifiable, and accountable. Every vote is signed and on-chain.
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: 32, flexWrap: 'wrap' }}>
          <button className="btn btn--primary btn--lg" onClick={onConnect} disabled={connecting}>
            <img src={metamaskFox} alt="" width="18" height="18" style={{ display: 'inline', verticalAlign: 'middle' }} />
            {connecting ? 'Connecting…' : 'Connect with MetaMask'}
          </button>
          <button className="btn btn--ghost btn--lg" onClick={onObserve}>Browse as observer →</button>
        </div>
      </div>

      <div className="pr-connect-side">
        <div className="pr-connect-orbit" aria-hidden="true">
          <Element115 size="full" />
        </div>
        <div className="pr-connect-stats">
          {stats.map(s => (
            <div className="pr-cstat" key={s.lab}>
              <div className="v">{s.v}</div>
              <div className="lab">{s.lab}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Vote progress bar ────────────────────────────────────────────────────────
function VoteBar({ yes, no, challenge }) {
  const total = Math.max(1, yes + no);
  const yp = Math.round((yes / total) * 100);
  return (
    <div className={`pr-vote-bar ${challenge ? 'is-challenge' : ''}`} style={{ '--yp': `${yp}fr`, '--np': `${100 - yp}fr` }}>
      <div className="yes" /><div className="no" />
    </div>
  );
}

// ── Review row (queue) ───────────────────────────────────────────────────────
function ReviewRow({ b, mine, onVote, onLapse, onPreview, onHistory, peerCount }) {
  const archived = ARCHIVED.has(b.status);
  const rejected = REJECTED.has(b.status);
  const voting   = b.status === 'pending';
  const approvals = b.approve_count || 0;
  const rejections = b.reject_count || 0;
  const left = daysRemaining(b.submitted_at, PENDING_WINDOW_DAYS);
  const lapsable = voting && left === 0;
  const rowCls = mine ? 'is-mine' : archived ? 'is-archived' : rejected ? 'is-rejected-binding' : '';

  return (
    <div className={`pr-row ${rowCls}`} data-tier={b.tier}>
      <div className="pr-row-tier"><div className="ring">{tierRoman(b.tier)}</div>{tierWord(b.tier)}</div>
      <div className="pr-row-meta">
        <div className="top">
          <span>Submitted {ago(b.submitted_at)}</span><span>·</span>
          <span className="badge">{b.type || tierWord(b.tier)}</span>
        </div>
        <h4 className="title is-clickable" role="button" tabIndex={0}
          onClick={() => onPreview(b)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPreview(b); } }}
          title="Open the full evidence record">{b.title}</h4>
        {(b.source || b.year) && <p className="src">{b.source}{b.year ? <> · <span className="yr">{b.year}</span></> : null}</p>}
        <div className="pr-filed">
          <span className="lab"><span className="evi">ID · {String(b.id).slice(0, 8)}…</span></span>
          <CopyChip value={b.id} label="evidence id" />
          <button type="button" className="pr-row-viewfull" onClick={() => onPreview(b)}>View full record →</button>
        </div>
      </div>
      <div className="pr-row-vote">
        <button type="button" className="pr-vote-history" onClick={() => onHistory(b)}
          title="See every signed vote on this evidence">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l3 1.5" />
          </svg>
          Vote history
        </button>
        <VoteBar yes={approvals} no={rejections} />
        <div className="pr-vote-tally">
          <span className="y"><b>{approvals}</b> approve{mine ? <em className="incl"> · incl. you</em> : null}</span>
          <span className="n"><b>{rejections}</b> reject</span>
        </div>
        {archived && <div className="pr-vote-thresh ok">✓ Approved · in archive</div>}
        {rejected && <div className="pr-vote-thresh bad">× {b.status} · not in archive</div>}
      </div>
      <div className="pr-row-actions">
        {voting && !mine && (
          <>
            <button className="pr-vote-btn yes" onClick={() => onVote(b, 'approve')}>✓ Approve</button>
            <button className="pr-vote-btn no" onClick={() => onVote(b, 'reject')}>× Reject</button>
          </>
        )}
        {voting && mine && <span className="pr-vote-btn voted">✓ You voted</span>}
        {archived && <span className="pr-vote-btn voted">✓ Filed in archive</span>}
        {rejected && <span className="pr-vote-btn sealed">× Not in archive</span>}
        <div className={`pr-vote-window ${left != null && left <= 2 ? 'is-urgent' : ''}`}>
          {voting ? (left === 0 ? 'window closed' : `${left} d left`) : 'sealed'}
        </div>
        {lapsable && <button className="pr-vote-btn no" onClick={() => onLapse(b)}>Mark lapsed</button>}
      </div>
    </div>
  );
}

// ── Challenge row ────────────────────────────────────────────────────────────
function ChallengeRow({ b, mine, onVote, onFinalize, onPreview, peerCount }) {
  const sup = b.challenge_votes || 0;
  const def = b.defense_votes || 0;
  const depT = deprecateThreshold(b.tier, peerCount);
  const left = daysRemaining(b.challenged_at, CHALLENGE_WINDOW_DAYS);
  const finalizable = left === 0;
  return (
    <div className="pr-row is-contested" data-tier={b.tier}>
      <div className="pr-row-tier"><div className="ring">{tierRoman(b.tier)}</div>{tierWord(b.tier)}</div>
      <div className="pr-row-meta">
        <div className="top">
          <span className="pill pill--contested" style={{ fontSize: 9 }}><span className="dot" />Contested</span>
          <span>·</span><span>{ago(b.challenged_at)}</span>
        </div>
        <h4 className="title is-clickable" role="button" tabIndex={0}
          onClick={() => onPreview(b)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPreview(b); } }}
          title="Open the full evidence record">{b.title}</h4>
        {(b.source || b.year) && <p className="src">{b.source}{b.year ? <> · <span className="yr">{b.year}</span></> : null}</p>}
        <div className="pr-filed">
          <span className="lab"><span className="evi">ID · {String(b.id).slice(0, 8)}…</span></span>
          <CopyChip value={b.id} label="evidence id" />
          <button type="button" className="pr-row-viewfull" onClick={() => onPreview(b)}>View full record →</button>
        </div>
        {b.challenge_reason && <p className="pr-challenge-quote">“{b.challenge_reason}”</p>}
      </div>
      <div className="pr-row-vote">
        <div className="label" style={{ marginBottom: 4 }}>Challenge / defend</div>
        <VoteBar yes={sup} no={def} challenge />
        <div className="pr-vote-tally">
          <span className="s"><b>{sup}</b> support</span>
          <span className="d"><b>{def}</b> defend</span>
        </div>
        <div className="pr-vote-thresh">Deprecates at {depT} of {peerCount} peer{peerCount === 1 ? '' : 's'}</div>
      </div>
      <div className="pr-row-actions">
        {!mine && !finalizable && (
          <>
            <button className="pr-vote-btn challenge" onClick={() => onVote(b, true)}>Support challenge</button>
            <button className="pr-vote-btn defend" onClick={() => onVote(b, false)}>Defend evidence</button>
          </>
        )}
        {mine && <span className="pr-vote-btn voted">✓ You voted</span>}
        {finalizable && <button className="pr-vote-btn defend" onClick={() => onFinalize(b)}>Finalize</button>}
        <div className={`pr-vote-window ${left != null && left <= 2 ? 'is-urgent' : ''}`}>
          {finalizable ? 'window closed' : `${left} d left`}
        </div>
      </div>
    </div>
  );
}

// ── Evidence preview modal ───────────────────────────────────────────────────
//
// Shows a binding's full evidence record exactly as it renders in the public
// archive (shared EvidenceDetailBody) so a reviewer sees precisely what they are
// voting on — the queue card alone is too thin to judge a filing. The status
// reads "In peer review" since the record is still under review, not canon.
function EvidencePreviewModal({ b, onClose, statusLabel = 'In peer review' }) {
  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!b) return null;
  return createPortal(
    <div className="ev-modal-backdrop is-open" onClick={onClose}>
      <div className="ev-modal" onClick={(e) => e.stopPropagation()}>
        <button className="ev-modal-close" onClick={onClose} aria-label="Close">×</button>
        <EvidenceDetailBody e={b} statusLabel={statusLabel} />
        <p className="ev-modal-id" title={`Evidence id · ${b.id}`}>
          <span className="ev-modal-id-label">ID</span>
          <span className="ev-modal-id-value">{b.id}</span>
          <CopyChip value={b.id} label="evidence id" />
        </p>
      </div>
    </div>,
    document.body,
  );
}

// ── Sign modal ───────────────────────────────────────────────────────────────
function SignModal({ payload, onCancel, onSign }) {
  const [note, setNote] = useState(payload?.note || '');
  if (!payload) return null;
  const needsNote = payload.action === 'open_challenge';
  const requiresSig = SIG_ACTIONS.has(payload.action);
  const verdict = VERDICT_STYLE[payload.verdict];
  return createPortal(
    <div className="pr-modal-scrim" onClick={onCancel}>
      <div className="pr-modal" onClick={e => e.stopPropagation()}>
        <h3>{payload.title}</h3>
        {payload.evidenceTitle && <p className="pr-vote-evi">{payload.evidenceTitle}</p>}
        {payload.sub && <p className="sub">{payload.sub}</p>}
        {verdict && (
          <div className="pr-vote-verdict">
            <span className="lab">Verdict</span>
            <span className="val" style={{ color: verdict.color }}>{verdict.label}</span>
          </div>
        )}
        <div className="field">
          <label>{needsNote ? 'Grounds for challenge (required)' : 'Deliberation note (optional)'}</label>
          <textarea rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder={needsNote ? 'What specific claim is wrong or misleading…' : 'Why this verdict…'} />
        </div>
        <div className="pr-modal-actions">
          <button className="btn btn--ghost btn--sm" onClick={onCancel}>Cancel</button>
          <button className="btn btn--primary btn--sm" disabled={needsNote && !note.trim()} onClick={() => onSign(note)}>
            {requiresSig ? 'Sign & submit' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Propose pillar/topic modal ───────────────────────────────────────────────
//
// A taxonomy node is never empty: a pillar is proposed with its first topic AND
// a founding piece of evidence; a topic is proposed with a founding piece of
// evidence. We write the off-chain rows (proposed node(s) + pending evidence +
// binding), then file one bundled on-chain proposal. Ratifying the bundle
// canonizes the founding evidence in the same endorsement gate.
function ProposeModal({ tax, me, onClose, onDone, setToast }) {
  const [kind, setKind] = useState(tax.pillars.length ? 'topic' : 'pillar');
  const [parent, setParent] = useState(tax.pillars[0]?.id || '');
  const [node, setNode] = useState({ title: '', tag: '', blurb: '' });   // the pillar/topic node
  const [ftopic, setFtopic] = useState({ title: '', blurb: '' });                  // founding topic (pillar kind)
  const [ev, setEv] = useState({ tier: 2, type: 'Paper', title: '', source: '', year: '', excerpt: '', link: '', tags: '' });
  const [busy, setBusy] = useState(false);

  // The slug (= node id, on-chain node_hash) is derived from the title, not
  // hand-entered: one less field, and peers never see a raw slug to fuss over.
  const slugify = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const nodeSlug = slugify(node.title);
  const ftopicSlug = slugify(ftopic.title);
  const setNodeK = (k) => (e) => setNode(s => ({ ...s, [k]: e.target.value }));
  const setEvK = (k) => (e) => setEv(s => ({ ...s, [k]: e.target.value }));
  const canSubmit = !busy && nodeSlug && ev.title.trim() && (kind === 'pillar' ? !!ftopicSlug : !!parent);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const tags = ev.tags.split(',').map(s => s.trim()).filter(Boolean);
      const evidence = { type: ev.type, tier: Number(ev.tier), title: ev.title, source: ev.source, year: ev.year, excerpt: ev.excerpt, link: ev.link, tags };
      // Mint the evidence id client-side: it is an INPUT to the on-chain call,
      // and is reused for the off-chain rows once the tx confirms.
      const evidenceId = crypto.randomUUID();
      const contentHash = await computeContentHash({
        title: ev.title.trim(), source: ev.source.trim() || null, year: ev.year.trim() || null,
        excerpt: ev.excerpt.trim() || null, link: ev.link.trim() || null, tier: Number(ev.tier),
      });

      let bundle, sendOnChain, foundingTopicSlug, nodeHash;
      if (kind === 'pillar') {
        const pillarHash = await slugToBytes32(nodeSlug);
        const pillarMeta = await computeMetaHash({ kind: 'pillar', slug: nodeSlug, parent: '', title: node.title.trim(), blurb: node.blurb.trim(), tag: node.tag.trim() });
        const topicHash  = await slugToBytes32(ftopicSlug);
        const topicMeta  = await computeMetaHash({ kind: 'topic', slug: ftopicSlug, parent: nodeSlug, title: ftopic.title.trim(), blurb: ftopic.blurb.trim(), tag: '' });
        foundingTopicSlug = ftopicSlug;
        nodeHash = pillarHash;
        bundle = {
          kind: 'pillar', proposed_by: me?.addr || null,
          pillar: { id: nodeSlug, node_hash: pillarHash, title: node.title, tag: node.tag, blurb: node.blurb, meta_hash: pillarMeta },
          topic: { id: ftopicSlug, pillar_id: nodeSlug, node_hash: topicHash, title: ftopic.title, blurb: ftopic.blurb, meta_hash: topicMeta },
          evidence,
        };
        sendOnChain = () => proposePillarOnChain(pillarHash, pillarMeta, topicHash, topicMeta, evidenceId, Number(ev.tier), contentHash);
      } else {
        const topicHash  = await slugToBytes32(nodeSlug);
        const topicMeta  = await computeMetaHash({ kind: 'topic', slug: nodeSlug, parent, title: node.title.trim(), blurb: node.blurb.trim(), tag: '' });
        const parentHash = await slugToBytes32(parent);
        foundingTopicSlug = nodeSlug;
        nodeHash = topicHash;
        bundle = {
          kind: 'topic', proposed_by: me?.addr || null,
          topic: { id: nodeSlug, pillar_id: parent, node_hash: topicHash, title: node.title, blurb: node.blurb, meta_hash: topicMeta },
          evidence,
        };
        sendOnChain = () => proposeTopicOnChain(topicHash, parentHash, topicMeta, evidenceId, Number(ev.tier), contentHash);
      }
      const bindingHash = await bindingKey(evidenceId, await slugToBytes32(foundingTopicSlug));

      // 1. On-chain proposal FIRST — nothing is written off-chain until it
      //    confirms, so a rejected or reverted tx leaves no orphaned rows.
      let txHash = null;
      if (CONSENSUS_ADDR) {
        txHash = await sendOnChain();
        await waitForTx(txHash);
      }

      // 2. Off-chain rows now that the bundle exists on-chain. The indexer's
      //    reorg buffer (head − CONFIRMATIONS) guarantees these land before it
      //    reconciles this block, so it still flips them to ratified / canon.
      const { bindingId, error } = await proposeTaxonomyBundle({ ...bundle, evidenceId, bindingHash });
      if (error) throw error;

      // 3. Proposer's founding endorsement (endorser #1 on-chain) — a signed log
      //    entry. Best-effort: the proposal is already filed, so neither a
      //    rejected signature nor a log-write hiccup should fail the flow.
      try {
        const endorseSig = await signAttestation(
          { evidenceId, topicId: foundingTopicSlug, phase: 'taxonomy', verdict: 'endorse', note: '' },
          me.addr,
        );
        await endorseNodeSupabase({
          nodeHash, evidenceId, topicId: foundingTopicSlug, bindingId,
          peerAddr: me.addr, peerHandle: me.handle, note: '', sig: endorseSig, txHash,
        });
      } catch (endErr) { if (endErr?.code !== 4001) console.warn('Endorsement log failed (proposal is filed):', endErr); }

      setToast({ type: 'info', msg: `Proposed ${kind} “${node.title.trim()}” + founding evidence` });
      onDone();
    } catch (e) {
      setToast({ type: 'err', msg: e?.message || 'Proposal failed' });
    } finally { setBusy(false); }
  };

  return createPortal(
    <div className="pr-modal-scrim" onClick={onClose}>
      <div className="pr-modal" onClick={e => e.stopPropagation()}>
        <h3>Propose {kind === 'pillar' ? 'a pillar' : 'a topic'}</h3>
        <p className="sub">Widen the archive with a new pillar, or deepen one with a topic. Every new node ships with a founding piece of evidence — peers endorse to ratify the bundle.</p>
        <div className="field">
          <label>Kind</label>
          <select value={kind} onChange={e => setKind(e.target.value)}>
            <option value="pillar">Pillar · wider</option>
            <option value="topic" disabled={!tax.pillars.length}>Topic · deeper</option>
          </select>
        </div>
        {kind === 'topic' && (
          <div className="field">
            <label>Parent pillar</label>
            <select value={parent} onChange={e => setParent(e.target.value)}>
              {tax.pillars.map(p => <option key={p.id} value={p.id}>{p.n} · {p.title}</option>)}
            </select>
          </div>
        )}
        <div className="field"><label>{kind === 'pillar' ? 'Pillar title' : 'Topic title'}</label><input value={node.title} onChange={setNodeK('title')} placeholder="Consciousness & non-locality" /></div>
        {kind === 'pillar' && <div className="field"><label>Tag</label><input value={node.tag} onChange={setNodeK('tag')} placeholder="Mind · Non-local" /></div>}
        <div className="field"><label>{kind === 'pillar' ? 'Pillar blurb' : 'Topic blurb'}</label><textarea rows={2} value={node.blurb} onChange={setNodeK('blurb')} /></div>

        {kind === 'pillar' && (
          <>
            <h4 style={{ margin: '14px 0 4px' }}>Founding topic</h4>
            <div className="field"><label>Topic title</label><input value={ftopic.title} onChange={e => setFtopic(s => ({ ...s, title: e.target.value }))} placeholder="Pre-cognition" /></div>
            <div className="field"><label>Topic blurb</label><textarea rows={2} value={ftopic.blurb} onChange={e => setFtopic(s => ({ ...s, blurb: e.target.value }))} /></div>
          </>
        )}

        <h4 style={{ margin: '14px 0 4px' }}>Founding evidence</h4>
        <p className="sub" style={{ marginTop: 0 }}>The first piece of evidence filed under this topic. It is canonized when the bundle is ratified.</p>
        <div className="field">
          <label>Tier</label>
          <select value={ev.tier} onChange={setEvK('tier')}>
            <option value={1}>I — Peer-reviewed</option>
            <option value={2}>II — Documented</option>
            <option value={3}>III — Testimony</option>
          </select>
        </div>
        <div className="field">
          <label>Type</label>
          <select value={ev.type} onChange={setEvK('type')}>
            {['Paper','Book','Podcast','Documentary','Video','Declassified','Testimony','Lecture','Study','Method','Witness','Art','Photograph','Document'].map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="field"><label>Evidence title</label><input value={ev.title} onChange={setEvK('title')} placeholder="The Tao of Physics" /></div>
        <div className="field"><label>Source / author</label><input value={ev.source} onChange={setEvK('source')} placeholder="Fritjof Capra · Shambhala" /></div>
        <div className="field"><label>Year</label><input value={ev.year} onChange={setEvK('year')} placeholder="1975" /></div>
        <div className="field"><label>Excerpt</label><textarea rows={2} value={ev.excerpt} onChange={setEvK('excerpt')} placeholder="Why this evidence belongs here…" /></div>
        <div className="field"><label>Source URL</label><input value={ev.link} onChange={setEvK('link')} placeholder="https://…" /></div>
        <div className="field"><label>Tags (comma-separated)</label><input value={ev.tags} onChange={setEvK('tags')} placeholder="quantum, mysticism" /></div>

        <div className="pr-modal-actions">
          <button className="btn btn--ghost btn--sm" onClick={onClose}>Cancel</button>
          <button className="btn btn--accent btn--sm" disabled={!canSubmit} onClick={submit}>{busy ? 'Proposing…' : 'Propose'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Nominate peer modal ──────────────────────────────────────────────────────
function NominateModal({ onClose, onDone, setToast }) {
  const [addr, setAddr] = useState('');
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^0x[a-fA-F0-9]{40}$/.test(addr.trim());
  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const txHash = await nominatePeerOnChain(addr.trim(), handle.trim());
      await waitForTx(txHash);
      setToast({ type: 'info', msg: `Nominated ${handle.trim() || SHORT(addr.trim())}` });
      onDone();
    } catch (e) { setToast({ type: 'err', msg: e?.message || 'Nomination failed' }); }
    finally { setBusy(false); }
  };
  return createPortal(
    <div className="pr-modal-scrim" onClick={onClose}>
      <div className="pr-modal" onClick={e => e.stopPropagation()}>
        <h3>Nominate a peer</h3>
        <p className="sub">Nominate a wallet to join the named network. Peers endorse to verify.</p>
        <div className="field"><label>Wallet address</label><input value={addr} onChange={e => setAddr(e.target.value)} placeholder="0x…" /></div>
        <div className="field"><label>Handle</label><input value={handle} onChange={e => setHandle(e.target.value)} placeholder="@name.peer" /></div>
        <div className="pr-modal-actions">
          <button className="btn btn--ghost btn--sm" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary btn--sm" disabled={busy || !valid} onClick={submit}>{busy ? 'Nominating…' : 'Nominate'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Bundle vote confirm + sign modal (accept / reject) ───────────────────────
//
// A proposal is one bundle — a pillar carries its founding topic AND a first
// piece of evidence; a topic carries a founding piece of evidence. The peer
// casts ONE signed vote on the whole bundle:
//   • Accept (endorse) → at threshold the node (and, for a pillar, its founding
//     topic) ratifies and the founding evidence canonizes atomically on-chain.
//   • Reject → a signed dissent recorded off-chain (no on-chain reject exists);
//     the node simply lapses if endorsements never reach threshold.
// Either way we preview the bundle and sign an EIP-712 attestation; an accept
// also sends the on-chain endorseNode tx.
function BundleVoteModal({ payload, onCancel, onSign }) {
  const [note, setNote] = useState('');
  if (!payload) return null;
  const { node, kind, foundingTopic, evidence, verdict } = payload;
  const reject = verdict === 'reject';
  const needsNote = reject;   // a dissent must say why, like opening a challenge
  return createPortal(
    <div className="pr-modal-scrim" onClick={onCancel}>
      <div className="pr-modal" onClick={e => e.stopPropagation()}>
        <h3>{reject ? 'Reject' : 'Accept'} {kind === 'pillar' ? 'pillar bundle' : 'topic bundle'}</h3>
        <p className="sub">
          {reject
            ? <>One signed dissent on the whole bundle. Recorded off-chain on the public log; the proposal lapses if endorsements never reach threshold.</>
            : <>One signed vote on the whole bundle. At threshold the {kind === 'pillar' ? 'pillar, its founding topic,' : 'topic'} and the founding evidence ratify together — atomically, on-chain.</>}
        </p>
        <div className="preview">
          <b>{kind === 'pillar' ? 'pillar' : 'topic'}</b> {node.title} ({node.id}){'\n'}
          {kind === 'pillar' && <><b>founding topic</b> {foundingTopic?.title || '—'} ({foundingTopic?.id || '—'}){'\n'}</>}
          <b>evidence</b> {evidence?.title || '—'}{'\n'}
          <b>tier</b> {evidence?.tier ?? '—'}{evidence?.source ? <>{'\n'}<b>source</b> {evidence.source}</> : null}{'\n'}
          <b>phase</b> taxonomy{'\n'}
          <b>verdict</b> {reject ? 'reject' : 'endorse'}{'\n'}
          <b>note</b> {note || '—'}
        </div>
        <div className="field">
          <label>{needsNote ? 'Grounds for rejection (required)' : 'Deliberation note (optional)'}</label>
          <textarea rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder={needsNote ? 'What specifically is wrong with this proposal…' : 'Why this belongs in the archive…'} />
        </div>
        <div className="pr-modal-actions">
          <button className="btn btn--ghost btn--sm" onClick={onCancel}>Cancel</button>
          <button className={`btn btn--sm ${reject ? 'btn--danger' : 'btn--accent'}`} disabled={!evidence || (needsNote && !note.trim())} onClick={() => onSign(note)}>
            {reject ? 'Sign & reject' : 'Sign & endorse'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Taxonomy governance tab ──────────────────────────────────────────────────
const RETIRE_WINDOW_DAYS = 30; // mirrors PROPOSAL_WINDOW in EvidenceConsensus

// Shared taxonomy-proposal review state — the open proposals plus THIS peer's
// position on each (endorse read on-chain, reject read off-chain). Consumed by
// both the Taxonomy tab (to render + vote) and the VerifiedWorkspace gate (to
// know when taxonomy is cleared), so both agree on a single source of truth.
function useTaxonomyReview(me) {
  const { pillars: pPillars, topics: pTopics, refetch: refetchPending } = usePendingTaxonomy();
  const [chain, setChain] = useState({ threshold: 1, byHash: {}, mineByHash: {} });
  const [founding, setFounding] = useState({});            // founding binding+evidence, keyed by topic slug
  const [myRejects, setMyRejects] = useState(() => new Set()); // founding binding ids I rejected off-chain

  // A proposed topic whose parent pillar is ITSELF still proposed is a pillar
  // bundle's founding topic — it ratifies with its pillar, never on its own, so
  // it is not a standalone proposal. A proposed topic under a *ratified* pillar
  // is a standalone topic proposal with its own gate.
  const proposedPillarIds = useMemo(() => new Set(pPillars.map(p => p.id)), [pPillars]);
  const foundingTopicByPillar = useMemo(() => {
    const m = {};
    for (const t of pTopics) if (proposedPillarIds.has(t.pillar_id)) m[t.pillar_id] = t;
    return m;
  }, [pTopics, proposedPillarIds]);
  const standaloneTopics = useMemo(
    () => pTopics.filter(t => !proposedPillarIds.has(t.pillar_id)),
    [pTopics, proposedPillarIds],
  );

  // Founding evidence/binding for every proposed topic (founding + standalone).
  // Each proposal ships exactly one pending founding binding under its topic, so
  // we can key the map by topic slug.
  useEffect(() => {
    const ids = pTopics.map(t => t.id);
    if (!ids.length) { setFounding({}); return; }
    let cancelled = false;
    supabase
      .from('bindings')
      .select('id, evidence_id, topic_id, evidence:evidence_id(tier, type, title, source, year, excerpt, link, content_hash)')
      .in('topic_id', ids)
      .eq('status', 'pending')
      .then(({ data }) => {
        if (cancelled) return;
        const m = {};
        for (const b of data || []) m[b.topic_id] = { bindingId: b.id, evidenceId: b.evidence_id, ...(b.evidence || {}) };
        setFounding(m);
      });
    return () => { cancelled = true; };
  }, [pTopics]);

  const loadChain = useCallback(async () => {
    if (!CONSENSUS_ADDR) return;
    const [threshold, nodes] = await Promise.all([getTaxonomyThreshold(), getProposedNodesAggregated()]);
    const byHash = {}; for (const n of nodes) byHash[n.id] = n;
    const mineByHash = {};
    if (me) await Promise.all(nodes.map(async n => { mineByHash[n.id] = await hasEndorsedNode(n.id, me.addr); }));
    setChain({ threshold, byHash, mineByHash });
  }, [me]);
  useEffect(() => { loadChain(); }, [loadChain, pPillars.length, pTopics.length]);

  const loadRejects = useCallback(() => {
    if (!me) { setMyRejects(new Set()); return Promise.resolve(); }
    return fetchMyTaxonomyRejects(me.addr).then(setMyRejects);
  }, [me]);
  useEffect(() => { loadRejects(); }, [loadRejects, pPillars.length, pTopics.length]);

  // Flat list of independently-endorsable proposals (proposed pillars +
  // standalone topics), each carrying its founding topic + evidence.
  const openProposals = useMemo(() => ([
    ...pPillars.map(p => ({ node: p, kind: 'pillar', foundingTopic: foundingTopicByPillar[p.id] })),
    ...standaloneTopics.map(t => ({ node: t, kind: 'topic', foundingTopic: t })),
  ].map(o => ({ ...o, evidence: o.foundingTopic ? founding[o.foundingTopic.id] : null }))),
  [pPillars, standaloneTopics, foundingTopicByPillar, founding]);

  // node_hash -> 'endorse' | 'reject' | undefined (this peer's position).
  const voteStatus = useMemo(() => {
    const m = {};
    for (const o of openProposals) {
      const nh = o.node.node_hash;
      const fb = o.foundingTopic ? founding[o.foundingTopic.id]?.bindingId : null;
      if (chain.mineByHash[nh]) m[nh] = 'endorse';
      else if (fb && myRejects.has(fb)) m[nh] = 'reject';
    }
    return m;
  }, [openProposals, chain.mineByHash, founding, myRejects]);

  const pendingForMe = useMemo(
    () => openProposals.filter(o => !voteStatus[o.node.node_hash]).length,
    [openProposals, voteStatus],
  );

  const refetch = useCallback(() => Promise.all([refetchPending(), loadChain(), loadRejects()]),
    [refetchPending, loadChain, loadRejects]);

  return {
    pPillars, standaloneTopics, foundingTopicByPillar, founding, chain,
    openProposals, voteStatus,
    openCount: pPillars.length + standaloneTopics.length,
    pendingForMe, cleared: pendingForMe === 0,
    refetch, loadChain, loadRejects,
  };
}

function TaxonomyTab({ me, setToast, onPropose, review }) {
  const tax = useTaxonomy();
  const {
    pPillars, standaloneTopics, foundingTopicByPillar, founding, chain,
    voteStatus, openCount, refetch, loadChain, loadRejects,
  } = review;
  const [retire, setRetire] = useState({ threshold: 1, byHash: {} });
  const [subtab, setSubtab] = useState('pillars');  // 'pillars' | 'topics'
  const [voting, setVoting] = useState(null);       // bundle awaiting confirm + sign
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try { await refetch(); } finally { setRefreshing(false); }
  };

  // Ratified pillars that actually hold topics (the retire surface is a
  // pillar → topics tree; a ratified pillar always has ≥1 topic by the on-chain
  // auto-retire invariant, so this is just `tax.pillars` defensively filtered).
  const ratifiedPillars = useMemo(
    () => (tax.pillars || []).filter(p => (p.topics || []).length > 0),
    [tax],
  );
  // Flat list of ratified topics — the retire surface reads per-topic retire state.
  const ratifiedTopics = useMemo(
    () => ratifiedPillars.flatMap(p => p.topics || []),
    [ratifiedPillars],
  );

  const loadRetire = useCallback(async () => {
    if (!CONSENSUS_ADDR || ratifiedTopics.length === 0) { setRetire({ threshold: 1, byHash: {} }); return; }
    const threshold = await getRetireThreshold();
    const byHash = {};
    // Only topics carry retire motions — a pillar retires automatically with its
    // last topic, so there is no per-pillar retire state to read.
    await Promise.all(ratifiedTopics.map(async t => {
      const active = await isRetireActive(t.node_hash);
      const [votes, motionAt, mine] = active
        ? await Promise.all([
            getRetireVoteCount(t.node_hash),
            getRetireMotionAt(t.node_hash),
            me ? hasVotedForRetire(t.node_hash, me.addr) : false,
          ])
        : [0, 0, false];
      byHash[t.node_hash] = { active, votes, motionAt, mine };
    }));
    setRetire({ threshold, byHash });
  }, [ratifiedTopics, me]);
  useEffect(() => { loadRetire(); }, [loadRetire]);

  // Open the confirm-sign modal for a bundle vote. `node` is the pillar (kind
  // 'pillar') or the topic (kind 'topic'); we resolve the founding topic +
  // evidence the vote acts on. `verdict` is 'endorse' (accept) or 'reject'.
  const openVote = (node, kind, verdict) => {
    const foundingTopic = kind === 'pillar' ? foundingTopicByPillar[node.id] : node;
    const evidence = foundingTopic ? founding[foundingTopic.id] : null;
    setVoting({ node, kind, foundingTopic, evidence, verdict });
  };

  const confirmVote = async (note) => {
    const payload = voting;
    setVoting(null);
    if (!payload) return;
    const { node, foundingTopic, evidence, verdict } = payload;
    if (!evidence || !foundingTopic) { setToast({ type: 'err', msg: 'Founding evidence not loaded yet — try again' }); return; }
    const topicSlug = foundingTopic.id;
    const reject = verdict === 'reject';
    let sig = null;
    try {
      sig = await signAttestation(
        { evidenceId: evidence.evidenceId, topicId: topicSlug, phase: 'taxonomy', verdict, note },
        me.addr,
      );
    } catch (e) { if (e?.code === 4001) return; setToast({ type: 'err', msg: 'Signature rejected' }); return; }
    try {
      if (reject) {
        // Off-chain dissent only — the contract has no reject-node call.
        await rejectNodeSupabase({
          nodeHash: node.node_hash, evidenceId: evidence.evidenceId, topicId: topicSlug,
          bindingId: evidence.bindingId, peerAddr: me.addr, peerHandle: me.handle, note, sig,
        });
        setToast({ type: 'info', msg: `Rejected “${node.title}”` });
        loadRejects(); refetch();
      } else {
        let txHash = null;
        if (CONSENSUS_ADDR) { txHash = await endorseNodeOnChain(node.node_hash); await waitForTx(txHash); }
        await endorseNodeSupabase({
          nodeHash: node.node_hash, evidenceId: evidence.evidenceId, topicId: topicSlug,
          bindingId: evidence.bindingId, peerAddr: me.addr, peerHandle: me.handle, note, sig, txHash,
        });
        setToast({ type: 'info', msg: `Endorsed “${node.title}”` });
        loadChain(); refetch();
      }
    } catch (e) { setToast({ type: 'err', msg: e?.message || (reject ? 'Reject failed' : 'Endorse failed') }); }
  };

  const motionRetire = async (n) => {
    try { await waitForTx(await motionRetireNodeOnChain(n.node_hash)); setToast({ type: 'info', msg: `Retire motion opened for “${n.title}”` }); loadRetire(); }
    catch (e) { setToast({ type: 'err', msg: e?.message || 'Motion failed' }); }
  };
  const voteRetire = async (n) => {
    try { await waitForTx(await voteRetireNodeOnChain(n.node_hash)); setToast({ type: 'info', msg: `Retire vote cast for “${n.title}”` }); loadRetire(); refetch(); }
    catch (e) { setToast({ type: 'err', msg: e?.message || 'Vote failed' }); }
  };
  const cancelRetire = async (n) => {
    try { await waitForTx(await cancelStaleRetireOnChain(n.node_hash)); setToast({ type: 'info', msg: `Stale retire motion cleared for “${n.title}”` }); loadRetire(); }
    catch (e) { setToast({ type: 'err', msg: e?.message || 'Cancel failed' }); }
  };

  const nowSec = Math.floor(Date.now() / 1000);

  // One pending-proposal card. `node` is the pillar or standalone topic row;
  // `foundingTopic` + `evidence` are the bundle detail the endorsement ratifies.
  // Endorsing opens the confirm-sign modal.
  const renderProposal = (node, kind, foundingTopic, evidence) => {
    const c = chain.byHash[node.node_hash];
    const endorsements = c?.endorsements ?? 1;
    const threshold = chain.threshold || 1;
    const pct = Math.min(100, (endorsements / threshold) * 100);
    const myVote = voteStatus[node.node_hash];   // 'endorse' | 'reject' | undefined
    return (
      <article className="pr-tax-card" key={node.id}>
        <div className="top">
          <span className={`kind ${kind === 'topic' ? 'is-topic' : ''}`}>{kind === 'topic' ? 'Topic · bundle' : 'Pillar · bundle'}</span>
          <span>Proposed {ago(node.created_at)}</span>
        </div>
        <h3 className="title">{node.title}</h3>
        <p className="slug">Label · <span style={{ color: 'var(--accent-2)' }}>{node.id}</span>{kind === 'topic' && tax.pillarMap[node.pillar_id] ? <> · under {tax.pillarMap[node.pillar_id].title}</> : null}</p>
        {node.blurb && <p className="blurb">{node.blurb}</p>}
        <div className="pr-tax-bundle">
          {kind === 'pillar' && (
            <div className="row"><span className="lab">Founding topic</span><span className="val">{foundingTopic?.title || '—'}</span></div>
          )}
          <div className="row"><span className="lab">Founding evidence</span><span className="val">{evidence ? <>{evidence.title} <em>· Tier {evidence.tier}</em></> : '—'}</span></div>
        </div>
        <div className="endorse">
          <div>
            <div className="label" style={{ marginBottom: 6 }}>Endorsements · {endorsements} of {threshold}</div>
            <div className="pr-tax-endorse-bar"><div className="fill" style={{ width: `${pct}%` }} /></div>
          </div>
          {me && (
            myVote === 'endorse' ? <span className="btn btn--ghost btn--sm" style={{ opacity: 0.6 }}>✓ Endorsed</span>
            : myVote === 'reject' ? <span className="btn btn--ghost btn--sm" style={{ opacity: 0.6 }}>✗ Rejected</span>
            : (
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn--accent btn--sm" disabled={!evidence} onClick={() => openVote(node, kind, 'endorse')}>✓ Accept</button>
                <button className="btn btn--danger btn--sm" disabled={!evidence} onClick={() => openVote(node, kind, 'reject')}>✗ Reject</button>
              </div>
            )
          )}
        </div>
      </article>
    );
  };

  return (
    <section>
      <div className="pr-tab-head">
        <div>
          <span className="eyebrow">Taxonomy governance · accept or reject</span>
          <h2 style={{ marginTop: 10 }}><em>{openCount}</em> proposals open<br />{tax.pillars?.length || 0} pillars · {tax.topics?.length || 0} topics ratified.</h2>
        </div>
        {me && <button className="btn btn--primary" onClick={onPropose}>+ Propose pillar / topic</button>}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 22 }}>
        <div className="tabs pr-subtabs" role="tablist">
          <button className={subtab === 'pillars' ? 'is-active' : ''} onClick={() => setSubtab('pillars')}>Pillars <span style={{ marginLeft: 8, opacity: 0.7 }}>{pPillars.length}</span></button>
          <button className={subtab === 'topics' ? 'is-active' : ''} onClick={() => setSubtab('topics')}>Topics <span style={{ marginLeft: 8, opacity: 0.7 }}>{standaloneTopics.length}</span></button>
        </div>
        <button className="btn btn--ghost btn--sm pr-refresh" onClick={refresh} disabled={refreshing} title="Refresh taxonomy proposals">
          <svg className={refreshing ? 'is-spinning' : ''} viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" />
          </svg>
          Refresh
        </button>
      </div>

      {subtab === 'pillars' && (
        pPillars.length === 0 ? (
          <div className="pr-empty"><h3>No pillar proposals</h3><p>Propose a pillar to widen the archive. Every pillar ships with a founding topic and a first piece of evidence — one endorsement ratifies the whole bundle.</p></div>
        ) : (
          <div className="pr-tax-grid">
            {pPillars.map(p => {
              const ft = foundingTopicByPillar[p.id];
              return renderProposal(p, 'pillar', ft, ft ? founding[ft.id] : null);
            })}
          </div>
        )
      )}

      {subtab === 'topics' && (
        standaloneTopics.length === 0 ? (
          <div className="pr-empty"><h3>No topic proposals</h3><p>Propose a topic to deepen an existing pillar. Every topic ships with a founding piece of evidence — one endorsement ratifies the bundle.</p></div>
        ) : (
          <div className="pr-tax-grid">
            {standaloneTopics.map(t => renderProposal(t, 'topic', t, founding[t.id]))}
          </div>
        )
      )}

      {/* Ratified taxonomy — retire by ceil(2n/3) supermajority. */}
      <div className="pr-tab-head" style={{ marginTop: 40, borderTop: '1px solid var(--hairline, rgba(255,255,255,.08))', paddingTop: 28 }}>
        <div>
          <span className="eyebrow">Ratified taxonomy · retire by supermajority</span>
          <h2 style={{ marginTop: 10 }}>Retire a topic by a ⅔ supermajority (<em>{retire.threshold}</em> votes).<br />A pillar retires automatically with its last topic</h2>
        </div>
      </div>

      {ratifiedPillars.length === 0 ? (
        <div className="pr-empty"><h3>Nothing ratified yet</h3><p>Ratified pillars and their topics will appear here, grouped for governance.</p></div>
      ) : (
        ratifiedPillars.map(p => (
          <div className="pr-pillar-group" key={p.id}>
            <header className="pr-pillar-group-head">
              <div className="roman">{toRoman(parseInt(p.n, 10) || 0)}</div>
              <div>
                <div className="tag">Pillar {p.n}</div>
                <div className="title">{p.title}</div>
              </div>
              <span className="pending-pill"><b>{p.topics.length}</b> topic{p.topics.length === 1 ? '' : 's'}</span>
              <span />
            </header>
            <div className="pr-pillar-group-body">
              <div className="pr-tax-grid">
                {p.topics.map(t => {
                  const r = retire.byHash[t.node_hash] || { active: false, votes: 0, motionAt: 0, mine: false };
                  const threshold = retire.threshold || 1;
                  const pct = Math.min(100, (r.votes / threshold) * 100);
                  const stale = r.active && r.motionAt > 0 && nowSec > r.motionAt + RETIRE_WINDOW_DAYS * 86400;
                  return (
                    <article className="pr-tax-card" key={t.id}>
                      <div className="top">
                        <span className="kind is-topic">Topic</span>
                        <span>{r.active ? 'Retire motion open' : 'Ratified'}</span>
                      </div>
                      <h3 className="title">{t.title}</h3>
                      <p className="slug">Label · <span style={{ color: 'var(--accent-2)' }}>{t.id}</span></p>
                      {me && (r.active ? (
                        <div className="endorse">
                          <div>
                            <div className="label" style={{ marginBottom: 6 }}>Retire votes · {r.votes} of {threshold}</div>
                            <div className="pr-tax-endorse-bar"><div className="fill" style={{ width: `${pct}%`, background: 'var(--danger, #e5484d)' }} /></div>
                          </div>
                          <div className="row" style={{ gap: 8 }}>
                            {r.mine
                              ? <span className="btn btn--ghost btn--sm" style={{ opacity: 0.6 }}>✓ Voted</span>
                              : <button className="btn btn--danger btn--sm" onClick={() => voteRetire(t)}>Vote retire</button>}
                            {stale && <button className="btn btn--ghost btn--sm" onClick={() => cancelRetire(t)}>Cancel stale</button>}
                          </div>
                        </div>
                      ) : (
                        <div className="endorse">
                          <div className="label" style={{ opacity: 0.7 }}>No retire motion</div>
                          <button className="btn btn--ghost btn--sm" onClick={() => motionRetire(t)}>Motion retire</button>
                        </div>
                      ))}
                    </article>
                  );
                })}
              </div>
            </div>
          </div>
        ))
      )}

      {voting && <BundleVoteModal payload={voting} onCancel={() => setVoting(null)} onSign={confirmVote} />}
    </section>
  );
}

// ── Peer registry tab ────────────────────────────────────────────────────────
function PeersTab({ me, peerCount, onNominate, setToast }) {
  const [peers, setPeers] = useState([]);
  const [nominees, setNominees] = useState([]);
  const [seedK, setSeedK] = useState(0);
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    if (!CONSENSUS_ADDR) return;
    const [p, n, k] = await Promise.all([getActivePeersAggregated(), getNomineesAggregated(), getSeedPhaseK()]);
    let mineRevoke = new Map();
    if (me) mineRevoke = await hasVotedForRevokeMany(p.map(x => x.addr), me.addr);
    const nomEnriched = me ? await Promise.all(n.map(async x => ({ ...x, mine: await hasEndorsedNominee(x.addr, me.addr) }))) : n;
    setPeers(p.map(x => ({ ...x, iVoted: mineRevoke.get(x.addr) })));
    setNominees(nomEnriched);
    setSeedK(Number(k) || 0);
  }, [me]);
  useEffect(() => { load(); }, [load]);

  const endorse = async (addr) => { try { await waitForTx(await endorseNomineeOnChain(addr)); setToast({ type: 'info', msg: 'Endorsed nominee' }); load(); } catch (e) { setToast({ type: 'err', msg: e?.message || 'Failed' }); } };
  const motion  = async (addr) => { try { await waitForTx(await motionRevokeOnChain(addr)); setToast({ type: 'info', msg: 'Revocation motioned' }); load(); } catch (e) { setToast({ type: 'err', msg: e?.message || 'Failed' }); } };
  const voteRev = async (addr) => { try { await waitForTx(await voteRevokeOnChain(addr)); setToast({ type: 'info', msg: 'Revoke vote cast' }); load(); } catch (e) { setToast({ type: 'err', msg: e?.message || 'Failed' }); } };
  const prune   = async (addr) => { try { await waitForTx(await pruneInactivePeerOnChain(addr)); setToast({ type: 'info', msg: 'Inactive peer pruned' }); load(); } catch (e) { setToast({ type: 'err', msg: e?.message || 'Failed' }); } };

  // Mirror the contract's INACTIVITY_WINDOW (30 days). A peer idle past it can be
  // pruned by anyone, but never below the seed-phase floor.
  const INACTIVITY_SECS = 30 * 86400;
  const aboveFloor = (peerCount ?? peers.length) > seedK;

  const ql = q.trim().toLowerCase();
  const fp = peers.filter(p => !ql || (p.handle || '').toLowerCase().includes(ql) || p.addr.includes(ql));
  const fn = nominees.filter(p => !ql || (p.handle || '').toLowerCase().includes(ql) || p.addr.includes(ql));

  return (
    <section>
      <div className="pr-tab-head">
        <div>
          <span className="eyebrow">Peer registry · the named network</span>
          <h2 style={{ marginTop: 10 }}><em>{peerCount ?? peers.length}</em> verified peers<br />{nominees.length} nominations open.</h2>
        </div>
        <div className="row">
          <div className="search" style={{ width: 280 }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search peers · handle / address" />
          </div>
          {me && <button className="btn btn--primary btn--sm" onClick={onNominate}>+ Nominate peer</button>}
        </div>
      </div>

      <div className="pr-registry">
        {fn.map(n => (
          <article className="pr-registry-card" key={n.addr}>
            <Jazz addr={n.addr} size={48} />
            <div>
              <div className="handle">{n.handle || SHORT(n.addr)} <span className="pill pill--pending" style={{ fontSize: 9 }}><span className="dot" />Nominee</span></div>
              <div className="addr">{SHORT(n.addr)}</div>
            </div>
            <div className="meta">
              <span><b>{n.endorsements}</b>endorsed</span>
              {me && (n.mine ? <span style={{ opacity: 0.6 }}>✓ endorsed</span> : <button className="btn btn--accent btn--xs" onClick={() => endorse(n.addr)}>+ Endorse</button>)}
            </div>
          </article>
        ))}
        {fp.map(p => {
          const isMe = me && p.addr === me.addr.toLowerCase();
          const prunable = p.lastActive && (Date.now() / 1000 - p.lastActive) > INACTIVITY_SECS && aboveFloor;
          return (
            <article className="pr-registry-card" key={p.addr}>
              <Jazz addr={p.addr} size={48} />
              <div>
                <div className="handle">{p.handle || SHORT(p.addr)} {isMe && <span className="pill" style={{ fontSize: 9, color: 'var(--accent)' }}>YOU</span>}{p.revActive && <span className="pill pill--contested" style={{ fontSize: 9 }}><span className="dot" />Revoking</span>}{prunable && <span className="pill pill--contested" style={{ fontSize: 9 }}><span className="dot" />Inactive</span>}</div>
                <div className="addr" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{SHORT(p.addr)}<CopyChip value={p.addr} label="address" /></div>
                {prunable && <div className="addr" style={{ opacity: 0.7 }}>prunable</div>}
              </div>
              <div className="meta">
                {prunable && !isMe && <button className="btn btn--danger btn--xs" onClick={() => prune(p.addr)} title="Remove a peer idle past 30 days">Prune inactive</button>}
                {p.revActive
                  ? (me && !isMe && (p.iVoted ? <span style={{ opacity: 0.6 }}>✓ voted</span> : <button className="btn btn--danger btn--xs" onClick={() => voteRev(p.addr)}>Vote revoke ({p.revVotes})</button>))
                  : (me && !isMe && <button className="btn btn--ghost btn--xs" onClick={() => motion(p.addr)}>Motion revoke</button>)}
              </div>
            </article>
          );
        })}
      </div>
      {fp.length === 0 && fn.length === 0 && <div className="pr-empty"><h3>No peers found</h3><p>Try a different search.</p></div>}
    </section>
  );
}

// ── Attestation log tab ──────────────────────────────────────────────────────
const VERDICTS = ['', 'approve', 'reject', 'challenge', 'defend'];
// Taxonomy endorsements are the same act as a review approval — show them as
// "approve" in the Vote history (no separate Endorse verdict).
const displayVerdict = (v) => (v === 'endorse' ? 'approve' : v);

// Pill-shaped dropdown filtering the vote history by pillar. Replaces the old
// fixed P-1…P-4 button strip so every ratified pillar is reachable.
function PillarFilter({ pillars, value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const sel = pillars.find(p => p.id === value);
  return (
    <div className={`pr-pillar-filter ${open ? 'is-open' : ''}`} ref={ref}>
      <button
        type="button"
        className={`pr-pillar-trigger ${value ? 'is-active' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Filter the vote history by pillar"
      >
        <span className="pr-pillar-label">{sel ? `P-${sel.n} · ${sel.title}` : 'All pillars'}</span>
        <svg className="pr-pillar-chev" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      {open && (
        <div className="pr-pillar-menu" role="listbox">
          <button type="button" role="option" aria-selected={!value} className={`pr-pillar-opt ${!value ? 'is-sel' : ''}`} onClick={() => { onChange(''); setOpen(false); }}>
            <span className="pr-pillar-opt-n">All</span>
            <span className="pr-pillar-opt-title">All pillars</span>
          </button>
          {pillars.map(p => (
            <button key={p.id} type="button" role="option" aria-selected={value === p.id} className={`pr-pillar-opt ${value === p.id ? 'is-sel' : ''}`} onClick={() => { onChange(p.id); setOpen(false); }}>
              <span className="pr-pillar-opt-n">P-{p.n}</span>
              <span className="pr-pillar-opt-title">{p.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// One row of the vote history. Holds local state for the optional deliberation
// note: a peer may attach a note when voting, so the reveal toggle only renders
// when one exists, expanding a full-width panel beneath the row.
function LogRow({ r, tax, onOpen, handleMap }) {
  const [showNote, setShowNote] = useState(false);
  const note = (r.note || '').trim();
  const peerName = r.peer_handle || handleMap[r.peer_addr?.toLowerCase()] || SHORT(r.peer_addr);
  return (
    <div className={`pr-log-row ${showNote ? 'is-noted' : ''}`}>
      <span className="t">{ago(r.created_at)}</span>
      <span className={`verdict ${displayVerdict(r.verdict)}`}>{displayVerdict(r.verdict)}</span>
      <span className="pillar">{tax.pillarMap[r.pillar_id]?.title || '—'}</span>
      <span className="title" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {r.evidence_title
          ? <button type="button" className="pr-log-evi" onClick={() => onOpen(r)} title="Open the full evidence record">{r.evidence_title}</button>
          : '—'}
        {note && (
          <button
            type="button"
            className={`pr-log-note-btn ${showNote ? 'is-open' : ''}`}
            onClick={() => setShowNote(s => !s)}
            aria-expanded={showNote}
            title={showNote ? 'Hide deliberation note' : 'Show the peer’s deliberation note'}
          >
            <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
            Note
          </button>
        )}
      </span>
      <span className="peer-cell"><Jazz addr={r.peer_addr} size={22} />{peerName}<CopyChip value={r.peer_addr} label="peer address" /></span>
      <span className="tx"><AttestationVerifier a={r} handle={peerName} /></span>
      {note && showNote && (
        <div className="pr-log-note">
          <span className="pr-log-note-label">Deliberation note</span>
          <p>{note}</p>
        </div>
      )}
    </div>
  );
}

const HEALTH_PILL_CLASS = { ok: 'pill--live', stale: 'pill--stale', error: 'pill--error', unknown: 'pill--idle' };

// Fold the audit job's liveness into its result: "Integrity ok" is only
// trustworthy if the audit actually ran, so a down audit reads "unverified"
// (not a false green), and any open alert dominates with a red count.
function deriveIntegrity(audit, tamper) {
  if (tamper > 0) {
    return { cls: 'pill--error', text: `${tamper} tamper alert${tamper === 1 ? '' : 's'}`,
      title: `${tamper} open tamper alert${tamper === 1 ? '' : 's'} — a stored content/meta hash diverged from recompute` };
  }
  if (tamper == null) return { cls: 'pill--idle', text: 'Integrity —', title: 'Loading integrity status…' };
  const lastClean = audit?.lastSuccess ? `last verified ${ago(audit.lastSuccess)}` : 'never verified';
  if (!audit || audit.state !== 'ok') {
    return { cls: 'pill--stale', text: 'Integrity unverified',
      title: `No drift on record, but the audit isn't running (${audit?.short ?? 'unknown'}) — integrity is not currently being confirmed · ${lastClean}` };
  }
  return { cls: 'pill--canon', text: 'Integrity ok', title: `No hash drift · ${lastClean}` };
}

// Operator health strip. Indexer liveness is its own pill; the audit job and the
// tamper-alert count are one concern (the watchdog and its finding) and collapse
// into a single Integrity pill.
function SystemHealthStrip() {
  const { services } = useSystemHealth();
  const tamper = useTamperAlertCount();
  const [showHint, setShowHint] = useState(false);
  const liveness = services.filter(s => s.name !== 'audit-content-hash');
  const audit = services.find(s => s.name === 'audit-content-hash');
  const integrity = deriveIntegrity(audit, tamper);
  return (
    <div className="pr-health" role="status" aria-label="System health">
      <span className="pr-health-label pr-health-hint">
        System
        <button
          type="button"
          className="pr-hint-btn"
          aria-label="What these indicators mean"
          aria-expanded={showHint}
          title="What these indicators mean"
          onClick={() => setShowHint(v => !v)}
        >?</button>
        {showHint && (
          <>
            <div className="pr-hint-scrim" onClick={() => setShowHint(false)} />
            <div className="pr-hint-pop pr-hint-pop--left" role="dialog" aria-label="System health explained">
              <strong>Indexer</strong>
              <p>Whether the chain indexer is keeping the archive in sync. It mirrors on-chain events — votes, evidence, ratifications — into Supabase every minute. <em>Live</em> = synced; <em>stalled</em> = it stopped, so the archive may be running behind the chain.</p>
              <strong>Integrity</strong>
              <p>The daily audit recomputes every record's content/meta hash and compares it to what's stored. <em>Ok</em> = no drift and the audit is current; <em>tamper alerts</em> = a stored hash diverged; <em>unverified</em> = no drift on record, but the audit isn't running so integrity can't currently be confirmed.</p>
            </div>
          </>
        )}
      </span>
      {liveness.map(s => (
        <span
          key={s.name}
          className={`pill ${HEALTH_PILL_CLASS[s.state]}`}
          style={{ fontSize: 9 }}
          title={s.lastSuccess ? `${s.label} · last success ${ago(s.lastSuccess)}` : s.label}
        >
          <span className="dot" />{s.service} <em style={{ fontStyle: 'normal', opacity: 0.7 }}>{s.short}</em>
        </span>
      ))}
      <span className={`pill ${integrity.cls}`} style={{ fontSize: 9 }} title={integrity.title}>
        <span className="dot" />{integrity.text}
      </span>
    </div>
  );
}

function LogTab({ initialQuery = '' }) {
  const [q, setQ] = useState(initialQuery);
  const [debounced, setDebounced] = useState(initialQuery);
  const [verdict, setVerdict] = useState('');
  const [pillar, setPillar] = useState('');
  const [preview, setPreview] = useState(null);
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  const { log, loading, hasMore, loadMore, total } = useAttestationLog(30, debounced, verdict);
  const tax = useTaxonomy();
  const handleMap = usePeerHandleMap();
  const shown = pillar ? log.filter(r => r.pillar_id === pillar) : log;

  const openPreview = async (r) => {
    const p = await fetchBindingPreview({ bindingId: r.binding_id, evidenceId: r.evidence_id, pillarId: r.pillar_id, topicId: r.topic_id });
    if (p) setPreview(p);
  };

  return (
    <section>
      <div className="pr-tab-head">
        <div>
          <span className="eyebrow">Vote history · searchable</span>
          <h2 style={{ marginTop: 10 }}><em>{total ?? log.length}</em> signed votes</h2>
        </div>
      </div>

      <div className="pr-log-controls">
        <div className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search by title, peer handle, address, or UUID" />
        </div>
        <PillarFilter pillars={tax.pillars} value={pillar} onChange={setPillar} />
        <div className="tabs">
          {VERDICTS.map(v => <button key={v || 'any'} className={verdict === v ? 'is-active' : ''} onClick={() => setVerdict(v)}>{v ? v[0].toUpperCase() + v.slice(1) : 'Any verdict'}</button>)}
        </div>
      </div>

      <div className="pr-log">
        <div className="pr-log-row is-head"><span>When</span><span>Verdict</span><span>Pillar</span><span>Evidence</span><span>Peer</span><span>Proof</span></div>
        {shown.map(r => <LogRow key={r.id} r={r} tax={tax} onOpen={openPreview} handleMap={handleMap} />)}
        {!loading && shown.length === 0 && <div className="pr-log-row"><span style={{ gridColumn: '1 / -1', color: 'var(--ink-faint)' }}>No attestations match.</span></div>}
      </div>
      <div className="pr-log-foot">
        {hasMore && <button className="btn btn--ghost btn--sm" onClick={loadMore} disabled={loading}>{loading ? 'Loading…' : 'Load 30 more'}</button>}
      </div>
      {preview && <EvidencePreviewModal b={preview} onClose={() => setPreview(null)} statusLabel={null} />}
    </section>
  );
}

// ── Batch clear-all gate strip ───────────────────────────────────────────────
//
// Always-visible overview of the unified gate: the three consensus surfaces a
// peer must clear (reviews · challenges · taxonomy) before the front of any
// shared queue advances to their next batch. Each step is a jump link to that
// tab, shows how many items are still owed on the current batch, and ticks green
// when cleared — so it's obvious at a glance what's blocking the next batch.
function BatchGate({ surfaces, allCleared, onJump }) {
  return (
    <div className={`pr-gate ${allCleared ? 'is-clear' : ''}`} role="status" aria-label="Batch clear-all gate">
      <div className="pr-gate-head">
        <span className="pr-gate-eyebrow">Batch gate</span>
        {!allCleared && (
          <span className="pr-gate-msg">Your next batch loads only once all three surfaces are cleared.</span>
        )}
      </div>
      <div className="pr-gate-steps">
        {surfaces.map(s => {
          const done = s.left === 0;
          const more = done && s.total > 0;   // batch cleared, but more wait behind it
          return (
            <button
              key={s.key}
              type="button"
              className={`pr-gate-step ${done ? 'is-done' : 'is-todo'}`}
              onClick={() => onJump(s.tab)}
              title={done ? `${s.label} batch clear${more ? ` · ${s.total} more queued` : ''}` : `${s.left} ${s.label.toLowerCase()} to clear before the next batch`}
            >
              <span className="pr-gate-mark">{done ? '✓' : s.left}</span>
              <span className="pr-gate-text">
                <span className="pr-gate-label">{s.label}</span>
                <span className="pr-gate-state">{done ? (more ? `${s.total} more queued` : 'clear') : 'to clear now'}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Verified workspace ───────────────────────────────────────────────────────
function VerifiedWorkspace({ me, isGenesis, peerCount, setToast }) {
  const [tab, setTab] = useState('queue');
  const [logQuery, setLogQuery] = useState('');
  const seeHistory = (b) => { setLogQuery(b.id); setTab('log'); };
  const [pendingSign, setPendingSign] = useState(null);
  const [showPropose, setShowPropose] = useState(false);
  const [showNominate, setShowNominate] = useState(false);
  const [chainPending, setChainPending] = useState(null);
  const [cooldown, setCooldown] = useState(0);
  const [preview, setPreview] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingCh, setRefreshingCh] = useState(false);
  const [beating, setBeating] = useState(false);
  const [showBeatHint, setShowBeatHint] = useState(false);

  const { queue, refetch: refetchQueue } = usePendingBindings();
  const { contested, refetch: refetchContested } = useContestedBindings();
  const { queue: queued, refetch: refetchQueued } = useQueuedBindings();
  const reviewCount = useMyReviewCount(me?.addr);
  // Shared taxonomy-proposal state — also drives the unified clear-all gate, so
  // it lives here and is passed down to the Taxonomy tab (one source of truth).
  const taxReview = useTaxonomyReview(me);
  const [capacity, setCapacity] = useState({ active: 0, max: 0 });

  // Liveness clock — the on-chain `lastActive` ticks down toward the 30-day
  // INACTIVITY_WINDOW after which any peer can prune this one. We read it to tint
  // the heartbeat green when fresh and progressively red as the window closes.
  const INACTIVITY_SECS = 30 * 86400;
  const [lastActive, setLastActive] = useState(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const loadLastActive = useCallback(() => {
    if (!CONSENSUS_ADDR || !me?.addr) return;
    getLastActive(me.addr).then(t => { setLastActive(Number(t) || 0); setNow(Date.now() / 1000); }).catch(() => {});
  }, [me?.addr]);
  // Reload after every on-chain action that bumps liveness (votes move reviewCount).
  useEffect(() => { loadLastActive(); }, [loadLastActive, reviewCount]);
  // Tick once a minute so the colour keeps creeping red on a long-idle tab.
  useEffect(() => { const id = setInterval(() => setNow(Date.now() / 1000), 60_000); return () => clearInterval(id); }, []);

  const loadCapacity = useCallback(() => {
    if (!CONSENSUS_ADDR) return;
    Promise.all([getActiveReviewCount(), getReviewCapacity()])
      .then(([a, m]) => setCapacity({ active: Number(a) || 0, max: Number(m) || 0 }))
      .catch(() => {});
  }, []);
  useEffect(() => { loadCapacity(); }, [loadCapacity, queue.length, queued.length]);

  const promote = async (b) => {
    try {
      await waitForTx(await promoteOnChain(b.id, slugToBytes32(b.topicId)));
      setToast({ type: 'info', msg: 'Promoted into review' });
      refetchQueued(); refetchQueue(); loadCapacity();
    } catch (e) { setToast({ type: 'err', msg: e?.message || 'Failed' }); }
  };

  const beat = async () => {
    setBeating(true);
    try {
      await waitForTx(await heartbeatOnChain());
      loadLastActive();
      setToast({ type: 'info', msg: 'Heartbeat sent — liveness refreshed' });
    } catch (e) { setToast({ type: 'err', msg: e?.message || 'Failed' }); }
    finally { setBeating(false); }
  };

  // Manual queue refresh — realtime usually keeps the queue current, but a vote
  // that resolves a binding can lag, leaving it lingering. Re-pull the shared
  // queue, the waiting list, and review capacity on demand.
  const refreshQueue = async () => {
    setRefreshing(true);
    try { await Promise.all([refetchQueue(), refetchQueued()]); loadCapacity(); }
    finally { setRefreshing(false); }
  };

  // Same on-demand re-pull for the contested queue — realtime usually keeps it
  // current, but a vote that resolves a challenge can lag.
  const refreshChallenges = async () => {
    setRefreshingCh(true);
    try { await refetchContested(); }
    finally { setRefreshingCh(false); }
  };

  const [myVotes, setMyVotes] = useState({});
  const [myChVotes, setMyChVotes] = useState({});

  useEffect(() => { if (me) getChallengeCooldownRemaining(me.addr).then(setCooldown); }, [me, contested.length]);

  useEffect(() => {
    if (!CONSENSUS_ADDR || !me || !queue.length) return;
    let cancelled = false;
    (async () => {
      const pairs = queue.map(b => ({ key: b.bindingId, uuid: b.id, topicId: slugToBytes32(b.topicId) }));
      const m = await hasVotedManyOnChain(pairs, 0, me.addr);
      if (!cancelled) setMyVotes(prev => ({ ...Object.fromEntries([...m].map(([k, v]) => [k, v ? 'cast' : undefined])), ...prev }));
    })();
    return () => { cancelled = true; };
  }, [queue, me]);
  useEffect(() => {
    if (!CONSENSUS_ADDR || !me || !contested.length) return;
    let cancelled = false;
    (async () => {
      const pairs = contested.map(b => ({ key: b.bindingId, uuid: b.id, topicId: slugToBytes32(b.topicId) }));
      const m = await hasVotedManyOnChain(pairs, 1, me.addr);
      if (!cancelled) setMyChVotes(prev => ({ ...Object.fromEntries([...m].map(([k, v]) => [k, v ? 'cast' : undefined])), ...prev }));
    })();
    return () => { cancelled = true; };
  }, [contested, me]);

  // ── Personal review + challenge batches ─────────────────────────────────────
  // `queue` / `contested` arrive in the SHARED order every peer agrees on
  // (review: boost → FIFO → id; challenge: FIFO by challenged_at → id). Each
  // personal queue is that shared pool minus what THIS peer has already resolved
  // — a peer's vote advances only their own cursor; the binding stays in the
  // shared pool (and in other peers' queues) until the network resolves it.
  const personalQueue = useMemo(() => queue.filter(b => !myVotes[b.bindingId]), [queue, myVotes]);
  const byId = useMemo(() => Object.fromEntries(queue.map(b => [b.bindingId, b])), [queue]);
  const challengePersonal = useMemo(() => contested.filter(b => !myChVotes[b.bindingId]), [contested, myChVotes]);
  const contestedById = useMemo(() => Object.fromEntries(contested.map(b => [b.bindingId, b])), [contested]);

  const [batchIds, setBatchIds] = useState([]);
  const [chBatchIds, setChBatchIds] = useState([]);
  const batch = batchIds.map(id => byId[id]).filter(Boolean);
  const challengeBatch = chBatchIds.map(id => contestedById[id]).filter(Boolean);

  // ── Unified clear-all gate ──────────────────────────────────────────────────
  // Each surface is "cleared" when this peer owes nothing on its current batch
  // (votes cast or items network-resolved). The next batch in EITHER queue loads
  // only once ALL THREE surfaces are cleared, so a peer can never churn reviews
  // while challenges or taxonomy proposals pile up unaddressed — consensus
  // always advances on every aspect of the platform together.
  const reviewBatchCleared    = batch.every(b => !!myVotes[b.bindingId]);
  const challengeBatchCleared = challengeBatch.every(b => !!myChVotes[b.bindingId]);
  const taxCleared            = taxReview.cleared;
  const allCleared            = reviewBatchCleared && challengeBatchCleared && taxCleared;

  // A batch holds its current ≤3 while the peer still owes votes on it OR while
  // any OTHER surface is still outstanding (the gate). Only when everything is
  // cleared does the front of the shared order advance to the next 3.
  useEffect(() => {
    setBatchIds(prev => {
      const present    = prev.filter(id => byId[id]);        // drop network-resolved items
      const actionable = present.filter(id => !myVotes[id]); // items I still owe a vote
      const next = (actionable.length > 0 || !allCleared)
        ? present
        : personalQueue.slice(0, 3).map(b => b.bindingId);
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) return prev;
      return next;
    });
  }, [personalQueue, byId, myVotes, allCleared]);

  useEffect(() => {
    setChBatchIds(prev => {
      const present    = prev.filter(id => contestedById[id]);
      const actionable = present.filter(id => !myChVotes[id]);
      const next = (actionable.length > 0 || !allCleared)
        ? present
        : challengePersonal.slice(0, 3).map(b => b.bindingId);
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) return prev;
      return next;
    });
  }, [challengePersonal, contestedById, myChVotes, allCleared]);

  const runSigned = async (sign, note) => {
    setPendingSign(null);
    let sig = null;
    if (SIG_ACTIONS.has(sign.action)) {
      try {
        sig = await signAttestation({ evidenceId: sign.subject, topicId: sign.topicSlug, phase: sign.phase, verdict: sign.verdict, note }, me.addr);
      } catch (e) { if (e?.code === 4001) return; setToast({ type: 'err', msg: 'Signature rejected' }); return; }
    }
    try { await sign.onConfirm(sig, note); }
    catch (e) { setToast({ type: 'err', msg: e?.message || 'Action failed' }); setChainPending(null); }
  };

  const handleVote = (b, verdict) => {
    setPendingSign({
      action: 'review_vote', phase: 'review', verdict, subject: b.id, topicSlug: b.topicId,
      title: 'Vote on Evidence',
      evidenceTitle: b.title,
      sub: `Filed under ${b.topicTitle}`,
      onConfirm: async (sig, note) => {
        let txHash = null;
        if (CONSENSUS_ADDR) {
          txHash = await castReviewVoteOnChain(b.id, slugToBytes32(b.topicId), verdict === 'approve');
          setChainPending('Confirming on-chain…'); await waitForTx(txHash); setChainPending(null);
        }
        await castReviewVote(b, verdict, me.addr, me.handle, note, sig, txHash, peerCount);
        setMyVotes(v => ({ ...v, [b.bindingId]: verdict }));
        setToast({ type: 'info', msg: 'Vote recorded' });
        refetchQueue();
      },
    });
  };

  const handleChallengeVote = (b, support) => {
    const verdict = support ? 'challenge' : 'defend';
    setPendingSign({
      action: 'challenge_vote', phase: 'challenge', verdict, subject: b.id, topicSlug: b.topicId,
      title: 'Vote on Evidence',
      evidenceTitle: b.title,
      sub: `Filed under ${b.topicTitle}`,
      onConfirm: async (sig, note) => {
        let txHash = null;
        if (CONSENSUS_ADDR) {
          txHash = await castChallengeVoteOnChain(b.id, slugToBytes32(b.topicId), support);
          setChainPending('Confirming on-chain…'); await waitForTx(txHash); setChainPending(null);
        }
        await castChallengeVote(b, support, me.addr, me.handle, note, sig, txHash, peerCount);
        setMyChVotes(v => ({ ...v, [b.bindingId]: verdict }));
        setToast({ type: 'info', msg: 'Challenge vote recorded' });
        refetchContested();
      },
    });
  };

  const handleLapse = async (b) => {
    try {
      let txHash = null;
      if (CONSENSUS_ADDR) { txHash = await markLapsedOnChain(b.id, slugToBytes32(b.topicId)); setChainPending('Confirming…'); await waitForTx(txHash); setChainPending(null); }
      setToast({ type: 'info', msg: 'Binding marked lapsed' }); refetchQueue();
    } catch (e) { setToast({ type: 'err', msg: e?.message || 'Failed' }); setChainPending(null); }
  };

  const handleFinalize = async (b) => {
    try {
      let txHash = null;
      if (CONSENSUS_ADDR) { txHash = await finalizeChallengeOnChain(b.id, slugToBytes32(b.topicId)); setChainPending('Confirming…'); await waitForTx(txHash); setChainPending(null); }
      await finalizeChallengeSupabase(b, me.addr, peerCount, txHash);
      setToast({ type: 'info', msg: 'Challenge finalized' }); refetchContested();
    } catch (e) { setToast({ type: 'err', msg: e?.message || 'Failed' }); setChainPending(null); }
  };

  // The heartbeat is a fallback for quiet stretches only. While any evidence
  // sits in review, the capacity waiting-list, or challenges, acting on it
  // already refreshes liveness — so the bare heartbeat is locked until all three
  // pools are empty, otherwise a peer could stay "alive" without participating.
  const canBeat = queue.length === 0 && queued.length === 0 && contested.length === 0;

  // Liveness freshness 1→0 (fresh→expired) drives a green→red hue on the button.
  const livenessFrac = useMemo(() => {
    if (!lastActive) return 1;
    return Math.max(0, Math.min(1, 1 - (now - lastActive) / INACTIVITY_SECS));
  }, [lastActive, now, INACTIVITY_SECS]);
  const beatColor = `hsl(${Math.round(120 * livenessFrac)} 70% 45%)`;
  const daysLeft = lastActive ? Math.max(0, Math.ceil((INACTIVITY_SECS - (now - lastActive)) / 86400)) : null;

  // What THIS peer still owes on each surface's current batch — drives the
  // badges and the "next batch locked" notices that point to whatever is
  // blocking the unified gate.
  const reviewBatchPending    = batch.filter(b => !myVotes[b.bindingId]).length;
  const challengeBatchPending = challengeBatch.filter(b => !myChVotes[b.bindingId]).length;
  const taxPending            = taxReview.pendingForMe;
  const gateItems = [
    reviewBatchPending    > 0 && { key: 'review',    tab: 'queue',      text: `${reviewBatchPending} review${reviewBatchPending === 1 ? '' : 's'}` },
    challengeBatchPending > 0 && { key: 'challenge', tab: 'challenges', text: `${challengeBatchPending} challenge${challengeBatchPending === 1 ? '' : 's'}` },
    taxPending            > 0 && { key: 'taxonomy',  tab: 'taxonomy',   text: `${taxPending} taxonomy proposal${taxPending === 1 ? '' : 's'}` },
  ].filter(Boolean);

  // The three surfaces for the always-visible gate strip — `left` is what THIS
  // peer still owes on the current batch (must hit 0 to unlock), `total` the rest
  // of their personal queue waiting behind it.
  const gateSurfaces = [
    { key: 'review',    tab: 'queue',      label: 'Reviews',    left: reviewBatchPending,    total: personalQueue.length },
    { key: 'challenge', tab: 'challenges', label: 'Challenges', left: challengeBatchPending, total: challengePersonal.length },
    { key: 'taxonomy',  tab: 'taxonomy',   label: 'Taxonomy',   left: taxPending,            total: taxPending },
  ];

  // Notice shown once the current surface's batch is cleared but the unified gate
  // still holds because another surface is outstanding. Lists the blockers with
  // jump links so the peer can clear every aspect before the next batch loads.
  const GateNotice = ({ surface }) => {
    const others = gateItems.filter(i => i.key !== surface);
    if (allCleared || others.length === 0) return null;
    return (
      <div className="pr-empty" style={{ marginTop: 20, textAlign: 'left', borderColor: 'var(--danger, #e5484d)' }}>
        <h3 style={{ marginBottom: 6 }}>Next batch locked</h3>
        <p style={{ color: 'var(--ink-soft)' }}>
          Consensus advances on every aspect together. Clear{' '}
          {others.map((o, i) => (
            <span key={o.key}>
              {i > 0 && (i === others.length - 1 ? ' and ' : ', ')}
              <button type="button" onClick={() => setTab(o.tab)}
                style={{ background: 'none', border: 0, padding: 0, color: 'var(--accent-2)', cursor: 'pointer', textDecoration: 'underline', font: 'inherit' }}>
                {o.text}
              </button>
            </span>
          ))}
          {' '}to load the next {surface === 'review' ? 'review' : 'challenge'} batch.
        </p>
      </div>
    );
  };

  return (
    <>
      <div className="pr-banner">
        <div className="pr-peer">
          <Jazz addr={me.addr} size={48} />
          <div className="pr-peer-info">
            <div className="pr-peer-handle">{me.handle || SHORT(me.addr)}</div>
            <div className="pr-peer-addr" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{me.addr}<CopyChip value={me.addr} label="address" /></div>
            <div className="pr-peer-tags">
              <span className="pill pill--canon" style={{ fontSize: 9 }}><span className="dot" />Verified</span>
              {isGenesis && <span className="pill" style={{ fontSize: 9 }}>Genesis peer</span>}
            </div>
          </div>
        </div>
        <div className="pr-stat"><div className="lab">Reviews signed</div><div className="v" style={{ whiteSpace: 'nowrap' }}>{reviewCount ?? '—'}<span className="u">total</span></div></div>
        <div className="pr-stat"><div className="lab">Challenge cooldown</div><div className={`v${cooldown === 0 ? ' status' : ''}`} style={{ whiteSpace: 'nowrap', color: cooldown === 0 ? 'var(--ok)' : undefined }}>{cooldown === 0 ? '● Can challenge' : <>{Math.ceil(cooldown / 86400)}<span className="u">days</span></>}</div></div>
        <div className="pr-stat pr-beat">
          <div className="lab">
            Liveness
            <button
              type="button"
              className="pr-hint-btn"
              aria-label="Why heartbeats matter"
              aria-expanded={showBeatHint}
              title="Why heartbeats matter"
              onClick={() => setShowBeatHint(v => !v)}
            >?</button>
          </div>
          <button className="btn btn--ghost btn--xs" onClick={beat} disabled={beating || !canBeat} style={canBeat ? { color: beatColor, borderColor: beatColor } : undefined} title={`${canBeat ? 'Refresh your liveness clock' : 'No heartbeat needed — evidence is waiting, and acting on it already refreshes your clock'}${daysLeft != null ? ` · ${daysLeft}d of liveness left` : ''}`}>{beating ? '♥ Sending…' : '♥ Heartbeat'}</button>
          {showBeatHint && (
            <>
              <div className="pr-hint-scrim" onClick={() => setShowBeatHint(false)} />
              <div className="pr-hint-pop" role="dialog" aria-label="Heartbeat philosophy">
                <strong>Liveness keeps consensus honest.</strong>
                <p>Every on-chain action — a vote, an endorsement — already refreshes your liveness clock. If you go silent for 30 days, the edge function automatically prunes you from the active set, so thresholds always reflect peers who are actually present.</p>
                <p>So the heartbeat unlocks only when there's genuinely no evidence to act on — nothing in review, nothing waiting for a slot, no open challenges. While any of those have items, acting on them is how you stay counted — a bare heartbeat is no substitute for participating.</p>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="pr-tabs">
        <div className="tabs" role="tablist">
          <button className={tab === 'queue' ? 'is-active' : ''} onClick={() => setTab('queue')}>Review queue <span style={{ marginLeft: 8, opacity: 0.7 }}>{personalQueue.length}</span></button>
          <button className={tab === 'challenges' ? 'is-active' : ''} onClick={() => setTab('challenges')}>Challenges <span style={{ marginLeft: 8, opacity: 0.7 }}>{challengePersonal.length}</span></button>
          <button className={tab === 'taxonomy' ? 'is-active' : ''} onClick={() => setTab('taxonomy')}>Taxonomy <span style={{ marginLeft: 8, opacity: 0.7 }}>{taxReview.pendingForMe}</span></button>
          <button className={tab === 'log' ? 'is-active' : ''} onClick={() => setTab('log')}>Vote history</button>
          <button className={tab === 'peers' ? 'is-active' : ''} onClick={() => setTab('peers')}>Peer registry</button>
        </div>
      </div>

      <SystemHealthStrip />

      <BatchGate surfaces={gateSurfaces} allCleared={allCleared} onJump={setTab} />

      {tab === 'queue' && (
        <section>
          <div className="pr-tab-head">
            <div>
              <span className="eyebrow">Your review batch · one vote per filing</span>
              <h2 style={{ marginTop: 10 }}><em>{batch.filter(b => !myVotes[b.bindingId]).length}</em> to review now<br />{queue.length} in the shared queue.</h2>
              <p className="small" style={{ color: 'var(--ink-soft)', marginTop: 10, maxWidth: '62ch' }}>
                Every peer works the <strong style={{ color: 'var(--ink)' }}>same shared queue in the same order</strong> — most-boosted filings first, then the oldest. You review up to three at a time; the next three load only once you've also cleared your <strong style={{ color: 'var(--ink)' }}>challenges and taxonomy proposals</strong> (see the batch gate above). Your vote only advances your own queue — each filing stays in review until the whole network reaches consensus.
              </p>
            </div>
            <button className="btn btn--ghost btn--sm pr-refresh" onClick={refreshQueue} disabled={refreshing} title="Refresh the review queue">
              <svg className={refreshing ? 'is-spinning' : ''} viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" />
              </svg>
              Refresh
            </button>
          </div>

          {personalQueue.length === 0 ? (
            <div className="pr-empty">
              <h3>{queue.length === 0 ? 'The queue is clear' : "You're all caught up"}</h3>
              <p>{queue.length === 0
                ? 'No filings are awaiting review yet. Boosted submissions are promoted into review and surface here.'
                : `You've voted every filing currently in review. ${queue.length} still awaiting other peers to reach consensus.`}</p>
            </div>
          ) : (
            <div>
              {batch.map(b => <ReviewRow key={b.bindingId} b={b} mine={!!myVotes[b.bindingId]} onVote={handleVote} onLapse={handleLapse} onPreview={setPreview} onHistory={seeHistory} peerCount={peerCount} />)}
              {reviewBatchPending > 0
                ? (personalQueue.length > reviewBatchPending && (
                    <p className="small" style={{ color: 'var(--ink-soft)', marginTop: 12 }}>
                      Finish your batch to reveal the next {Math.min(3, personalQueue.length - reviewBatchPending)}.
                    </p>
                  ))
                : <GateNotice surface="review" />}
            </div>
          )}

          {queued.length > 0 && (
            <div style={{ marginTop: 36 }}>
              <div className="pr-topic-bar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="n">Waiting for a review slot · {queued.length} queued (highest public boost first)</span>
              </div>
              {queued.map(b => (
                <div key={b.bindingId} className="pr-review-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{b.title}</div>
                    <div className="addr" style={{ opacity: 0.7 }}>{b.pillarTitle} · {b.topicTitle} · ✦ {b.queue_priority} boosts</div>
                  </div>
                  <button className="btn btn--ghost btn--xs" disabled={capacity.active >= capacity.max && capacity.max > 0} onClick={() => promote(b)} title={capacity.active >= capacity.max ? 'No free review slot yet' : 'Move into active review'}>Promote</button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'challenges' && (
        <section>
          <div className="pr-tab-head">
            <div>
              <span className="eyebrow">Your challenge batch · support or defend</span>
              <h2 style={{ marginTop: 10 }}><em>{challengeBatchPending}</em> to vote now<br />{contested.length} contested across the network.</h2>
              <p className="small" style={{ color: 'var(--ink-soft)', marginTop: 10, maxWidth: '62ch' }}>
                Every peer works the <strong style={{ color: 'var(--ink)' }}>same contested queue in the same order</strong> — the oldest challenge first. You vote up to three at a time; the next three load only once you've also cleared your <strong style={{ color: 'var(--ink)' }}>reviews and taxonomy proposals</strong> (see the batch gate above). Your vote only advances your own queue — each challenge stays open until the whole network reaches consensus.
              </p>
            </div>
            <button className="btn btn--ghost btn--sm pr-refresh" onClick={refreshChallenges} disabled={refreshingCh} title="Refresh the challenge queue">
              <svg className={refreshingCh ? 'is-spinning' : ''} viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" />
              </svg>
              Refresh
            </button>
          </div>

          {challengePersonal.length === 0 ? (
            <div className="pr-empty">
              <h3>{contested.length === 0 ? 'No active challenges' : "You're all caught up"}</h3>
              <p>{contested.length === 0
                ? 'Canon bindings under contest appear here. Open one from the public archive.'
                : `You've voted every challenge currently open. ${contested.length} still awaiting other peers to reach consensus.`}</p>
            </div>
          ) : (
            <div>
              {challengeBatch.map(b => <ChallengeRow key={b.bindingId} b={b} mine={!!myChVotes[b.bindingId]} onVote={handleChallengeVote} onFinalize={handleFinalize} onPreview={setPreview} peerCount={peerCount} />)}
              {challengeBatchPending > 0
                ? (challengePersonal.length > challengeBatchPending && (
                    <p className="small" style={{ color: 'var(--ink-soft)', marginTop: 12 }}>
                      Finish your batch to reveal the next {Math.min(3, challengePersonal.length - challengeBatchPending)}.
                    </p>
                  ))
                : <GateNotice surface="challenge" />}
            </div>
          )}
        </section>
      )}

      {tab === 'log' && <LogTab key={logQuery} initialQuery={logQuery} />}
      {tab === 'taxonomy' && <TaxonomyTab me={me} setToast={setToast} onPropose={() => setShowPropose(true)} review={taxReview} />}
      {tab === 'peers' && <PeersTab me={me} peerCount={peerCount} onNominate={() => setShowNominate(true)} setToast={setToast} />}

      {preview && <EvidencePreviewModal b={preview} onClose={() => setPreview(null)} />}
      {pendingSign && <SignModal payload={pendingSign} onCancel={() => setPendingSign(null)} onSign={(note) => runSigned(pendingSign, note)} />}
      {showPropose && <ProposeModalWrap me={me} onClose={() => setShowPropose(false)} setToast={setToast} />}
      {showNominate && <NominateModal onClose={() => setShowNominate(false)} onDone={() => setShowNominate(false)} setToast={setToast} />}

      {chainPending && <div className="pr-toast info"><span className="pill pill--live" style={{ border: 0, padding: 0 }}><span className="dot" /></span>{chainPending}</div>}
    </>
  );
}

function ProposeModalWrap({ me, onClose, setToast }) {
  const tax = useTaxonomy();
  return <ProposeModal tax={tax} me={me} onClose={onClose} onDone={onClose} setToast={setToast} />;
}

// ── Observer workspace (read-only, no wallet required) ───────────────────────
// Guests and non-peer wallets can browse the public record: the full attestation
// log and the named peer registry. The UI explains itself — an "observing"
// header, a clear two-tab switch, and a banner showing how to unlock actions.
function ObserverWorkspace({ wallet, peerCount, setToast }) {
  const [tab, setTab] = useState('log');
  return (
    <div className="pr-observer">
      <div className="pr-observer-intro">
        <span className="eyebrow">Observer mode · read-only</span>
        <h1 className="display" style={{ marginTop: 24 }}>The public record,<br /><em>open to everyone.</em></h1>
        <p className="lead" style={{ maxWidth: "60ch", marginTop: 24 }}>
          {wallet ? "This wallet is not yet a verified peer." : "You are viewing as an observer."} You can read every signed
          vote in the decision log and see all verified peers. To vote on evidence, challenge decisions, or propose new categories/topics,
          you need to be nominated and endorsed as a verified peer.
        </p>
      </div>

      <div className="pr-tabs">
        <div className="tabs" role="tablist">
          <button className={tab === 'log' ? 'is-active' : ''} onClick={() => setTab('log')}>Vote history</button>
          <button className={tab === 'peers' ? 'is-active' : ''} onClick={() => setTab('peers')}>Peer registry</button>
        </div>
      </div>

      <SystemHealthStrip />

      {tab === 'log'   && <LogTab />}
      {tab === 'peers' && <PeersTab me={null} peerCount={peerCount} onNominate={() => {}} setToast={setToast} />}
    </div>
  );
}

// ── Root ─────────────────────────────────────────────────────────────────────
export default function PeerReview() {
  // Seed from the cross-page cache so a returning verified peer lands on the
  // workspace immediately — without flashing the connect screen while the async
  // eth_accounts + on-chain peer checks resolve. The restore effect below
  // corrects the optimistic state (and clears it if actually disconnected).
  const [wallet, setWallet] = useState(cachedAddr);
  const [isPeer, setIsPeer] = useState(() => !!cachedPeer(cachedAddr())?.isPeer);
  const [isGenesis, setIsGenesis] = useState(() => !!cachedPeer(cachedAddr())?.isGenesis);
  const [peerHandle, setPeerHandle] = useState(() => cachedHandle(cachedAddr()));
  const [connecting, setConnecting] = useState(false);
  const [observerMode, setObserverMode] = useState(false);
  const [peerCount, setPeerCount] = useState(1);
  const [toast, setToast] = useState(null);

  const me = wallet ? { addr: wallet.toLowerCase(), handle: peerHandle } : null;

  const refreshContractState = useCallback(async () => {
    const c = await getActivePeerCount();
    if (c != null) setPeerCount(c);
  }, []);

  useEffect(() => { prefetchWallet(); refreshContractState(); }, [refreshContractState]);

  const clearWallet = useCallback(() => {
    setWallet(null); setIsPeer(false); setIsGenesis(false); setPeerHandle('');
    cacheAddr(null);
  }, []);

  // Resolve the real connection + peer state, then reconcile the optimistic
  // cache: persist it on success, or clear it if the wallet reports no account.
  const reconcile = useCallback(async (addr) => {
    if (!addr) { clearWallet(); return; }
    const peer = await isPeerActive(addr);
    const genesis = peer && await isGenesisPeer(addr);
    const handle = peer ? await getPeerHandle(addr) : '';
    setWallet(addr); setIsPeer(peer); setIsGenesis(genesis); setPeerHandle(handle || '');
    cacheAddr(addr); cachePeer(addr, { isPeer: peer, isGenesis: genesis }); cacheHandle(addr, handle || '');
  }, [clearWallet]);

  // Only auto-restore while a session is active. An explicit disconnect (or a
  // closed tab, which clears sessionStorage) ends the session, so we stay on the
  // connect screen instead of silently reconnecting from the granted permission.
  useEffect(() => {
    if (!window.ethereum) { clearWallet(); return; }
    if (!cachedAddr()) return;
    let cancelled = false;
    window.ethereum.request({ method: 'eth_accounts' })
      .then((accts) => { if (!cancelled) reconcile(accts[0] || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [reconcile, clearWallet]);

  const handleConnect = async () => {
    if (!window.ethereum) { if (isMobile()) window.location.href = metamaskDeepLink(); else setToast({ type: 'err', msg: 'MetaMask not found' }); return; }
    setConnecting(true);
    try {
      const { addr } = await connectWallet();
      if (CONSENSUS_ADDR) await switchToTargetChain();
      await reconcile(addr);
      setObserverMode(false);
      refreshContractState();
    } catch (e) { if (e?.code !== 4001) setToast({ type: 'err', msg: e?.message || 'Connect failed' }); }
    finally { setConnecting(false); }
  };

  const disconnect = useCallback(() => { clearWallet(); setObserverMode(false); }, [clearWallet]);

  useEffect(() => {
    if (!window.ethereum) return;
    const onAccts = (accts) => {
      const a = accts[0] || null;
      if (!a) { clearWallet(); return; }   // disconnected in MetaMask
      if (!cachedAddr()) return;           // signed off — ignore the still-granted account
      reconcile(a);
    };
    const onChain = () => window.location.reload();
    window.ethereum.on?.('accountsChanged', onAccts);
    window.ethereum.on?.('chainChanged', onChain);
    return () => { window.ethereum.removeListener?.('accountsChanged', onAccts); window.ethereum.removeListener?.('chainChanged', onChain); };
  }, [reconcile, clearWallet]);

  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); } }, [toast]);

  const verified = wallet && isPeer;
  const showConnect = !wallet && !observerMode;

  return (
    <div className="shell">
      <Nav wallet={wallet} handle={peerHandle} onConnect={handleConnect} onDisconnect={disconnect} connecting={connecting} />
      <main className="pr-shell">
        {showConnect && <ConnectScreen onConnect={handleConnect} onObserve={() => setObserverMode(true)} connecting={connecting} peerCount={peerCount} />}

        {!showConnect && !verified && (
          <ObserverWorkspace wallet={wallet} peerCount={peerCount} setToast={setToast} />
        )}

        {verified && <VerifiedWorkspace me={me} isGenesis={isGenesis} peerCount={peerCount} setToast={setToast} />}
      </main>
      {toast && <div className={`pr-toast ${toast.type}`} onClick={() => setToast(null)}>{toast.msg}</div>}
    </div>
  );
}
