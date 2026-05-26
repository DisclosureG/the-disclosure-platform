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
import RegistryProofVerifier from '../components/RegistryProofVerifier';
import EvidenceDetailBody from '../components/EvidenceDetailBody';
import {
  useTaxonomy, usePendingTaxonomy,
  deprecateThreshold, canonizeThreshold, bundleThreshold,
  PENDING_WINDOW_DAYS, CHALLENGE_WINDOW_DAYS, daysRemaining,
  usePendingBindings, useContestedBindings, useAttestationLog, useDerivedConsensusRejects, usePeerRegistryLog,
  useQueuedBindings, useMyReviewCount, usePeerHandleMap, fetchBindingPreview,
  useSystemHealth, useTamperAlertCount,
  castReviewVote, castChallengeVote, finalizeChallengeSupabase,
  proposeTaxonomyBundle, endorseNodeSupabase, rejectNodeSupabase, fetchMyTaxonomyRejects, fetchTaxonomyDissentCounts,
  castRevocationKeep, castRevocationDiscard, castNomineeEndorse, castNominate, castGovNote,
  fetchMyRevocationKeeps, fetchRevocationKeepCounts,
} from '../evidence-data';
import {
  connectWallet, switchToTargetChain, getActivePeerCount, getPeerHandle, isPeerActive,
  isGenesisPeer, getSeedPhaseK, isNominationsOpen, getOwner, getNomineeThreshold, getRevokeThreshold,
  endorseNominee as endorseNomineeOnChain,
  motionRevoke as motionRevokeOnChain,
  voteRevoke as voteRevokeOnChain,
  motionForceRenounce, voteForceRenounce, getForceRenounceActive, getForceRenounceVotes,
  heartbeatOnChain, pruneInactivePeerOnChain, getLastActive,
  castReviewVoteOnChain, castChallengeVoteOnChain, signVoteOnly,
  finalizeChallengeOnChain, markLapsedOnChain,
  waitForTx,
  nominatePeer as nominatePeerOnChain,
  addPeer as addPeerOnChain,
  hasEndorsedNominee,
  hasVotedManyOnChain, hasVotedForRevokeMany, getRevokeRound,
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
// Truncate a long identifier (UUID or 0x-hash) for display next to a copy chip.
const shortHash = (v) => { if (!v) return '—'; const s = String(v); return s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s; };
// Review / challenge votes are no longer pre-signed with an Attestation here —
// their authorising signature is the EIP-712 *Vote*, produced by the on-chain
// vote call (or signVoteOnly() in dev mode). So SIG_ACTIONS is now empty; it
// stays in place for any future runSigned action that does need a pre-sign.
const SIG_ACTIONS = new Set([]);
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
// `resolvedInBatch` flags a binding that left the shared queue (canon / expelled
// / lapsed) while still sitting in this peer's batch and never received this
// peer's vote: the row stays visible behind an Acknowledge action so the gate
// holds until the peer has actively cleared every batch slot, never silently
// advances around them.
function ReviewRow({ b, mine, resolvedInBatch, onVote, onLapse, onAck, onPreview, onHistory, peerCount }) {
  const archived = ARCHIVED.has(b.status);
  const rejected = REJECTED.has(b.status);
  const voting   = b.status === 'pending' && !resolvedInBatch;
  const approvals = b.approve_count || 0;
  const rejections = b.reject_count || 0;
  const canT = canonizeThreshold(b.tier, peerCount);
  const left = daysRemaining(b.submitted_at, PENDING_WINDOW_DAYS);
  const lapsable = voting && left === 0;
  const rowCls = resolvedInBatch ? 'is-archived' : mine ? 'is-mine' : archived ? 'is-archived' : rejected ? 'is-rejected-binding' : '';

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
        {voting && <div className="pr-vote-thresh">Approves at {canT} of {peerCount} peer{peerCount === 1 ? '' : 's'}</div>}
        {!resolvedInBatch && archived && <div className="pr-vote-thresh ok">✓ Approved · in archive</div>}
        {!resolvedInBatch && rejected && <div className="pr-vote-thresh bad">× {b.status} · not in archive</div>}
        {resolvedInBatch && <div className="pr-vote-thresh">Resolved by network before your vote · acknowledge to continue</div>}
      </div>
      <div className="pr-row-actions">
        {voting && !mine && (
          <>
            <button className="pr-vote-btn yes" onClick={() => onVote(b, 'approve')}>✓ Approve</button>
            <button className="pr-vote-btn no" onClick={() => onVote(b, 'reject')}>× Reject</button>
          </>
        )}
        {voting && mine && <span className="pr-vote-btn voted">✓ You voted</span>}
        {!resolvedInBatch && archived && <span className="pr-vote-btn voted">✓ Filed in archive</span>}
        {!resolvedInBatch && rejected && <span className="pr-vote-btn sealed">× Not in archive</span>}
        {resolvedInBatch && <button className="pr-vote-btn yes" onClick={() => onAck(b)}>Acknowledge</button>}
        {!resolvedInBatch && (
          <div className={`pr-vote-window ${left != null && left <= 2 ? 'is-urgent' : ''}`}>
            {voting ? (left === 0 ? 'window closed' : `${left} d left`) : 'sealed'}
          </div>
        )}
        {lapsable && <button className="pr-vote-btn no" onClick={() => onLapse(b)}>Mark lapsed</button>}
      </div>
    </div>
  );
}

// ── Challenge row ────────────────────────────────────────────────────────────
// `resolvedInBatch` mirrors ReviewRow: a contested binding the network resolved
// (deprecate / reaffirm) while it sat in this peer's challenge batch, never
// receiving their vote, holds an Acknowledge slot until cleared so the gate
// can't silently advance around them.
function ChallengeRow({ b, mine, resolvedInBatch, onVote, onFinalize, onAck, onPreview, peerCount }) {
  const sup = b.challenge_votes || 0;
  const def = b.defense_votes || 0;
  const depT = deprecateThreshold(b.tier, peerCount);
  const left = daysRemaining(b.challenged_at, CHALLENGE_WINDOW_DAYS);
  const finalizable = left === 0 && !resolvedInBatch;
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
        {!resolvedInBatch && <div className="pr-vote-thresh">Deprecates at {depT} of {peerCount} peer{peerCount === 1 ? '' : 's'}</div>}
        {resolvedInBatch && <div className="pr-vote-thresh">Resolved by network before your vote · acknowledge to continue</div>}
      </div>
      <div className="pr-row-actions">
        {!mine && !finalizable && !resolvedInBatch && (
          <>
            <button className="pr-vote-btn challenge" onClick={() => onVote(b, true)}>Support challenge</button>
            <button className="pr-vote-btn defend" onClick={() => onVote(b, false)}>Defend evidence</button>
          </>
        )}
        {mine && !resolvedInBatch && <span className="pr-vote-btn voted">✓ You voted</span>}
        {finalizable && <button className="pr-vote-btn defend" onClick={() => onFinalize(b)}>Finalize</button>}
        {resolvedInBatch && <button className="pr-vote-btn defend" onClick={() => onAck(b)}>Acknowledge</button>}
        {!resolvedInBatch && (
          <div className={`pr-vote-window ${left != null && left <= 2 ? 'is-urgent' : ''}`}>
            {finalizable ? 'window closed' : `${left} d left`}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Queue view toggle — "needs my review" vs "open votes" ─────────────────────
//
// The review and challenge surfaces split into two clean views: filings this
// peer still owes a vote on, and filings they've already signed a vote on. This
// segmented toggle switches between them; each side carries a live count.
function QueueToggle({ view, onChange, needsLabel, needsCount, openCount }) {
  const Count = ({ n, active }) => (
    <span style={{ marginLeft: 8, opacity: active ? 0.85 : 0.6 }}>{n}</span>
  );
  return (
    <div className="pr-queue-toggle" role="tablist">
      <button role="tab" aria-selected={view === 'needs'} className={view === 'needs' ? 'is-active' : ''} onClick={() => onChange('needs')}>
        {needsLabel}<Count n={needsCount} active={view === 'needs'} />
      </button>
      <button role="tab" aria-selected={view === 'open'} className={view === 'open' ? 'is-active' : ''} onClick={() => onChange('open')}>
        Open votes<Count n={openCount} active={view === 'open'} />
      </button>
    </div>
  );
}

// ── Open votes view — signed votes still awaiting network consensus ───────────
//
// The instant a peer signs a review or challenge vote, the binding leaves the
// "to vote" list and shows here, where its tally keeps live-updating as other
// peers vote. It drops off entirely once the network resolves it — the binding
// leaves the pending/contested query, so it leaves this list with it. Shared by
// the Review queue and Challenges tabs (caller supplies the row renderer).
function OpenVotesView({ items, renderRow, empty }) {
  if (!items.length) {
    return (
      <div className="pr-empty">
        <h3>No open votes yet</h3>
        <p>{empty}</p>
      </div>
    );
  }
  return (
    <div className="pr-openvotes-view">
      <p className="pr-openvotes-sub">
        <span className="pr-openvotes-livedot" aria-hidden="true" />
        Filings you&rsquo;ve signed a vote on — live until the network reaches consensus, then they leave the dashboard.
      </p>
      <div className="pr-queue-rows">{items.map(renderRow)}</div>
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
  // Vote actions still prompt a signature — now an EIP-712 *Vote* produced by
  // the on-chain vote call (or signVoteOnly in dev mode) inside onConfirm,
  // rather than a pre-signed Attestation gated through SIG_ACTIONS. Either way
  // the user signs, so the button still reads "Sign & submit".
  const requiresSig = SIG_ACTIONS.has(payload.action)
    || ['review_vote', 'challenge_vote', 'retire_node', 'force_renounce'].includes(payload.action);
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
  const [note, setNote] = useState('');
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
        // Tag is entered comma-separated and rendered as a floating-dot pair
        // ("Mind · Non-local"); the joined string is what we hash + store so the
        // meta_hash matches the pillar header. A lone tag, or one where the "·"
        // was typed by hand, passes through unchanged.
        const pillarTag = node.tag.split(',').map(s => s.trim()).filter(Boolean).join(' · ');
        const pillarMeta = await computeMetaHash({ kind: 'pillar', slug: nodeSlug, parent: '', title: node.title.trim(), blurb: node.blurb.trim(), tag: pillarTag });
        const topicHash  = await slugToBytes32(ftopicSlug);
        const topicMeta  = await computeMetaHash({ kind: 'topic', slug: ftopicSlug, parent: nodeSlug, title: ftopic.title.trim(), blurb: ftopic.blurb.trim(), tag: '' });
        foundingTopicSlug = ftopicSlug;
        nodeHash = pillarHash;
        bundle = {
          kind: 'pillar', proposed_by: me?.addr || null,
          pillar: { id: nodeSlug, node_hash: pillarHash, title: node.title, tag: pillarTag, blurb: node.blurb, meta_hash: pillarMeta },
          topic: { id: ftopicSlug, pillar_id: nodeSlug, node_hash: topicHash, title: ftopic.title, blurb: ftopic.blurb, meta_hash: topicMeta },
          evidence,
        };
        sendOnChain = () => proposePillarOnChain(pillarHash, pillarMeta, topicHash, topicMeta, evidenceId, Number(ev.tier), contentHash, note.trim());
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
        sendOnChain = () => proposeTopicOnChain(topicHash, parentHash, topicMeta, evidenceId, Number(ev.tier), contentHash, note.trim());
      }
      const bindingHash = await bindingKey(evidenceId, await slugToBytes32(foundingTopicSlug));

      // 1. On-chain proposal FIRST — nothing is written off-chain until it
      //    confirms, so a rejected or reverted tx leaves no orphaned rows. The
      //    propose call IS the proposer's founding endorsement (Vote phase 2), so
      //    it returns the same { sig, noteHash, round } the chain recovered.
      let txHash = null, proposeSig = null, proposeNoteHash = null, proposeRound = null;
      if (CONSENSUS_ADDR) {
        ({ txHash, sig: proposeSig, noteHash: proposeNoteHash, round: proposeRound } = await sendOnChain());
        await waitForTx(txHash);
      }

      // 2. Off-chain rows now that the bundle exists on-chain. The indexer's
      //    reorg buffer (head − CONFIRMATIONS) guarantees these land before it
      //    reconciles this block, so it still flips them to ratified / canon.
      const { bindingId, error } = await proposeTaxonomyBundle({ ...bundle, evidenceId, bindingHash });
      if (error) throw error;

      // 3. Proposer's founding endorsement log entry — reuse the propose
      //    signature (the proposer is endorser #1 on-chain). Dev mode (no
      //    contract) falls back to an off-chain Attestation so the note is still
      //    recorded. Best-effort: the proposal is already filed.
      try {
        let sig = proposeSig;
        if (!CONSENSUS_ADDR) {
          sig = await signAttestation(
            { evidenceId, topicId: foundingTopicSlug, phase: 'taxonomy', verdict: 'endorse', note: note.trim() },
            me.addr,
          );
        }
        await endorseNodeSupabase({
          nodeHash, evidenceId, topicId: foundingTopicSlug, bindingId,
          peerAddr: me.addr, peerHandle: me.handle, note: note.trim(), sig, txHash,
          round: proposeRound, noteHash: proposeNoteHash,
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
        {kind === 'pillar' && <div className="field"><label>Tag (comma-separated)</label><input value={node.tag} onChange={setNodeK('tag')} placeholder="Mind, Non-local" /></div>}
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
            {['Paper','Book','Podcast','Documentary','Video','Declassified','Testimony','Lecture','Study','Method','Investigation','Witness','Art','Photograph','Document'].map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="field"><label>Evidence title</label><input value={ev.title} onChange={setEvK('title')} placeholder="The Tao of Physics" /></div>
        <div className="field"><label>Source / author</label><input value={ev.source} onChange={setEvK('source')} placeholder="Fritjof Capra · Shambhala" /></div>
        <div className="field"><label>Year</label><input value={ev.year} onChange={setEvK('year')} placeholder="1975" /></div>
        <div className="field"><label>Excerpt</label><textarea rows={2} value={ev.excerpt} onChange={setEvK('excerpt')} placeholder="Why this evidence belongs here…" /></div>
        <div className="field"><label>Source URL</label><input value={ev.link} onChange={setEvK('link')} placeholder="https://…" /></div>
        <div className="field"><label>Tags (comma-separated)</label><input value={ev.tags} onChange={setEvK('tags')} placeholder="quantum, mysticism" /></div>

        <div className="field">
          <label>Deliberation note (optional)</label>
          <textarea rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="Why this belongs in the archive — recorded as your founding endorsement…" />
        </div>

        <div className="pr-modal-actions">
          <button className="btn btn--ghost btn--sm" onClick={onClose}>Cancel</button>
          <button className="btn btn--accent btn--sm" disabled={!canSubmit} onClick={submit}>{busy ? 'Proposing…' : 'Sign & propose'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Nominate / seed peer modal ───────────────────────────────────────────────
// `seed` switches to the owner-only seed-phase path: a direct addPeer that makes
// the wallet an active peer immediately (no endorsement gate), used while the
// network is below seedPhaseK and nominations are closed.
function NominateModal({ me, onClose, onDone, setToast, seed = false }) {
  const [addr, setAddr] = useState('');
  const [handle, setHandle] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^0x[a-fA-F0-9]{40}$/.test(addr.trim());
  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      if (seed) {
        // Owner seed path — a plain addPeer (no vote, no note).
        await waitForTx(await addPeerOnChain(addr.trim(), handle.trim()));
      } else {
        // Nominate is the nominator's own EIP-712-signed act (PeerVote kind 2).
        const { txHash, sig, round } = await nominatePeerOnChain(addr.trim(), handle.trim(), note.trim());
        await waitForTx(txHash);
        // Persist the deliberation note + the same signature the chain recovered,
        // best-effort (the on-chain nomination stands regardless).
        try { await castNominate({ nomineeAddr: addr.trim(), nominatorAddr: me.addr, round, note: note.trim(), sig }); }
        catch (e) { console.warn('Nominate note write failed (nomination stands):', e); }
      }
      setToast({ type: 'info', msg: `${seed ? 'Seeded' : 'Nominated'} ${handle.trim() || SHORT(addr.trim())}` });
      onDone();
    } catch (e) { if (e?.code === 4001) { setBusy(false); return; } setToast({ type: 'err', msg: e?.message || (seed ? 'Seeding failed' : 'Nomination failed') }); }
    finally { setBusy(false); }
  };
  return createPortal(
    <div className="pr-modal-scrim" onClick={onClose}>
      <div className="pr-modal" onClick={e => e.stopPropagation()}>
        <h3>{seed ? 'Seed a peer' : 'Nominate a peer'}</h3>
        <p className="sub">{seed
          ? 'Seed phase: as owner you add founding peers directly — each becomes active immediately, no endorsement needed. Once the seed quorum is reached this closes and peers join by nomination.'
          : 'Nominate a wallet to join the named network. Peers endorse to verify.'}</p>
        <div className="field"><label>Wallet address</label><input value={addr} onChange={e => setAddr(e.target.value)} placeholder="0x…" /></div>
        <div className="field"><label>Handle</label><input value={handle} onChange={e => setHandle(e.target.value)} placeholder="name" /></div>
        {!seed && (
          <div className="field">
            <label>Deliberation note (optional)</label>
            <textarea rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="Why this wallet should join the network…" />
          </div>
        )}
        <div className="pr-modal-actions">
          <button className="btn btn--ghost btn--sm" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary btn--sm" disabled={busy || !valid} onClick={submit}>{busy ? (seed ? 'Seeding…' : 'Nominating…') : (seed ? 'Seed peer' : 'Sign & nominate')}</button>
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
  const { pillars: rawPillars, topics: pTopics, refetch: refetchPending } = usePendingTaxonomy();
  const [chain, setChain] = useState({ threshold: 1, peerCount: 0, byHash: {}, mineByHash: {} });
  const [founding, setFounding] = useState({});            // founding binding+evidence, keyed by topic slug
  const [myRejects, setMyRejects] = useState(() => new Set()); // founding binding ids I rejected off-chain
  const [dissents, setDissents] = useState(() => new Map());   // founding binding id -> total off-chain reject count

  // A proposed topic whose parent pillar is ITSELF still proposed is a pillar
  // bundle's founding topic — it ratifies with its pillar, never on its own, so
  // it is not a standalone proposal. A proposed topic under a *ratified* pillar
  // is a standalone topic proposal with its own gate.
  const proposedPillarIds = useMemo(() => new Set(rawPillars.map(p => p.id)), [rawPillars]);
  const foundingTopicByPillar = useMemo(() => {
    const m = {};
    for (const t of pTopics) if (proposedPillarIds.has(t.pillar_id)) m[t.pillar_id] = t;
    return m;
  }, [pTopics, proposedPillarIds]);
  const rawStandaloneTopics = useMemo(
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
    const [threshold, peerCount, nodes] = await Promise.all([
      getTaxonomyThreshold(), getActivePeerCount(), getProposedNodesAggregated(),
    ]);
    const byHash = {}; for (const n of nodes) byHash[n.id] = n;
    const mineByHash = {};
    if (me) await Promise.all(nodes.map(async n => { mineByHash[n.id] = await hasEndorsedNode(n.id, me.addr); }));
    setChain({ threshold, peerCount: peerCount || 0, byHash, mineByHash });
  }, [me]);
  useEffect(() => { loadChain(); }, [loadChain, rawPillars.length, pTopics.length]);

  const loadRejects = useCallback(() => {
    if (!me) { setMyRejects(new Set()); return Promise.resolve(); }
    return fetchMyTaxonomyRejects(me.addr).then(setMyRejects);
  }, [me]);
  useEffect(() => { loadRejects(); }, [loadRejects, rawPillars.length, pTopics.length]);

  // Total off-chain dissent count per founding binding — used to hide proposals
  // whose ratification has become mathematically impossible.
  const loadDissents = useCallback(() => {
    const bindingIds = Object.values(founding).map(f => f?.bindingId).filter(Boolean);
    return fetchTaxonomyDissentCounts(bindingIds).then(setDissents);
  }, [founding]);
  useEffect(() => { loadDissents(); }, [loadDissents]);

  // A proposal is mathematically dead when remaining eligible endorsers
  // (activePeers − current endorsements − dissents) is less than the
  // endorsements still needed to reach bundleThreshold(tier). The contract
  // has no on-chain reject, so the on-chain row stays Proposed until the
  // 30-day window lapses — but we hide it from the vote queue so peers stop
  // being asked to act on a dead proposal.
  const deadHashes = useMemo(() => {
    const dead = new Set();
    const peers = chain.peerCount;
    if (!peers) return dead;
    const consider = (node, foundingTopic) => {
      if (!foundingTopic) return;
      const f = founding[foundingTopic.id];
      if (!f || !f.bindingId || !f.tier) return;
      const onchain = chain.byHash[node.node_hash];
      const endorsements = Number(onchain?.endorsements ?? 1); // proposer counts as #1
      const need = bundleThreshold(Number(f.tier), peers);
      const noCount = dissents.get(f.bindingId) || 0;
      const eligible = peers - endorsements - noCount;
      if (eligible < need - endorsements) dead.add(node.node_hash);
    };
    for (const p of rawPillars) consider(p, foundingTopicByPillar[p.id]);
    for (const t of rawStandaloneTopics) consider(t, t);
    return dead;
  }, [chain.peerCount, chain.byHash, rawPillars, rawStandaloneTopics, foundingTopicByPillar, founding, dissents]);

  const pPillars = useMemo(
    () => rawPillars.filter(p => !deadHashes.has(p.node_hash)),
    [rawPillars, deadHashes],
  );
  const standaloneTopics = useMemo(
    () => rawStandaloneTopics.filter(t => !deadHashes.has(t.node_hash)),
    [rawStandaloneTopics, deadHashes],
  );

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

  const refetch = useCallback(() => Promise.all([refetchPending(), loadChain(), loadRejects(), loadDissents()]),
    [refetchPending, loadChain, loadRejects, loadDissents]);

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
  const [retireSign, setRetireSign] = useState(null); // { node, mode: 'motion'|'vote' } awaiting note + sign
  const [refreshing, setRefreshing] = useState(false);
  const [preview, setPreview] = useState(null);     // founding evidence record opened in the full-record modal

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
    try {
      if (reject) {
        // Off-chain dissent only — the contract has no reject-node call, so this
        // stays an EIP-712 Attestation signed in the browser.
        let sig;
        try {
          sig = await signAttestation({ evidenceId: evidence.evidenceId, topicId: topicSlug, phase: 'taxonomy', verdict, note }, me.addr);
        } catch (e) { if (e?.code === 4001) return; setToast({ type: 'err', msg: 'Signature rejected' }); return; }
        await rejectNodeSupabase({
          nodeHash: node.node_hash, evidenceId: evidence.evidenceId, topicId: topicSlug,
          bindingId: evidence.bindingId, peerAddr: me.addr, peerHandle: me.handle, note, sig,
        });
        setToast({ type: 'info', msg: `Rejected “${node.title}”` });
        loadRejects(); refetch();
      } else {
        // Endorse is the on-chain by-sig Vote (phase 2): the signature the chain
        // recovers IS the off-chain record. Dev mode (no contract) falls back to
        // an Attestation so the note is still captured.
        let txHash = null, sig = null, noteHash = null, round = null;
        try {
          if (CONSENSUS_ADDR) {
            ({ txHash, sig, noteHash, round } = await endorseNodeOnChain(node.node_hash, note));
            await waitForTx(txHash);
          } else {
            sig = await signAttestation({ evidenceId: evidence.evidenceId, topicId: topicSlug, phase: 'taxonomy', verdict, note }, me.addr);
          }
        } catch (e) { if (e?.code === 4001) return; setToast({ type: 'err', msg: e?.message || 'Endorse failed' }); return; }
        await endorseNodeSupabase({
          nodeHash: node.node_hash, evidenceId: evidence.evidenceId, topicId: topicSlug,
          bindingId: evidence.bindingId, peerAddr: me.addr, peerHandle: me.handle, note, sig, txHash,
          round, noteHash,
        });
        setToast({ type: 'info', msg: `Endorsed “${node.title}”` });
        loadChain(); refetch();
      }
    } catch (e) { setToast({ type: 'err', msg: e?.message || (reject ? 'Reject failed' : 'Endorse failed') }); }
  };

  // Retire motion/vote are on-chain by-sig (Vote phase 3), so each opens a
  // note-capture sign modal first; runRetire signs + submits on confirm.
  const motionRetire = (n) => setRetireSign({ node: n, mode: 'motion' });
  const voteRetire   = (n) => setRetireSign({ node: n, mode: 'vote' });
  const runRetire = async (note) => {
    const sign = retireSign;
    setRetireSign(null);
    if (!sign) return;
    const { node: n, mode } = sign;
    try {
      const res = mode === 'motion'
        ? await motionRetireNodeOnChain(n.node_hash, note)
        : await voteRetireNodeOnChain(n.node_hash, note);
      await waitForTx(res.txHash);
      // Persist the deliberation note + the same Vote signature the chain
      // recovered so the retire shows in the shared vote history. Best-effort.
      try {
        await castGovNote({
          kind: 'retire', subject: n.node_hash, topicId: n.id, verdict: 'retire',
          round: res.round, note, noteHash: res.noteHash, sig: res.sig, txHash: res.txHash,
          peerAddr: me.addr, peerHandle: me.handle,
        });
      } catch (e) { console.warn('Retire note write failed (vote stands):', e); }
      setToast({ type: 'info', msg: mode === 'motion' ? `Retire motion opened for “${n.title}”` : `Retire vote cast for “${n.title}”` });
      loadRetire(); if (mode !== 'motion') refetch();
    } catch (e) { if (e?.code === 4001) return; setToast({ type: 'err', msg: e?.message || 'Retire failed' }); }
  };
  const cancelRetire = async (n) => {
    try { await waitForTx(await cancelStaleRetireOnChain(n.node_hash)); setToast({ type: 'info', msg: `Stale retire motion cleared for “${n.title}”` }); loadRetire(); }
    catch (e) { setToast({ type: 'err', msg: e?.message || 'Cancel failed' }); }
  };

  const nowSec = Math.floor(Date.now() / 1000);

  // One pending-proposal card. A bundle is rendered as stacked parts — the
  // PILLAR (pillar bundles only) → the TOPIC → the founding EVIDENCE — each
  // showing its full set of params so a peer can judge the whole filing before
  // endorsing. The evidence title/"View full record" open the same shared
  // EvidenceDetailBody preview the review queue uses. Endorsing opens the
  // confirm-sign modal. `node` is the pillar (kind 'pillar') or standalone
  // topic (kind 'topic'); `foundingTopic` is the bundled topic for a pillar.
  const renderProposal = (node, kind, foundingTopic, evidence) => {
    const c = chain.byHash[node.node_hash];
    const endorsements = c?.endorsements ?? 1;
    const threshold = chain.threshold || 1;
    const pct = Math.min(100, (endorsements / threshold) * 100);
    const myVote = voteStatus[node.node_hash];   // 'endorse' | 'reject' | undefined
    const pillar = kind === 'pillar' ? node : null;
    const topic = kind === 'pillar' ? foundingTopic : node;
    const parentPillar = pillar || tax.pillarMap[node.pillar_id];

    const openEvidence = () => {
      if (!evidence) return;
      setPreview({
        id: evidence.evidenceId,
        type: evidence.type, tier: evidence.tier, title: evidence.title,
        source: evidence.source, year: evidence.year, excerpt: evidence.excerpt,
        link: evidence.link, status: 'pending',
        pillarTitle: parentPillar?.title || '—',
        topicTitle: topic?.title || '—',
      });
    };

    return (
      <article className="pr-tax-card pr-bundle" key={node.id}>
        <div className="top">
          <span className={`kind ${kind === 'topic' ? 'is-topic' : ''}`}>{kind === 'topic' ? 'Topic · bundle' : 'Pillar · bundle'}</span>
          <span>Proposed {ago(node.created_at)}</span>
        </div>

        <div className="pr-bundle-parts">
          {pillar && (
            <div className="pr-part is-pillar">
              <div className="pr-part-head"><span className="pr-part-badge">Pillar</span><span className="pr-part-flag">wider</span></div>
              <h3 className="pr-part-title">{pillar.title}</h3>
              {pillar.blurb && <p className="pr-part-blurb">{pillar.blurb}</p>}
              <div className="pr-part-rows">
                <div className="pr-part-row"><span className="k">Label</span><span className="v mono">{pillar.id}<CopyChip value={pillar.id} label="pillar slug" /></span></div>
                {pillar.tag && <div className="pr-part-row"><span className="k">Tags</span><span className="v">{pillar.tag}</span></div>}
                <div className="pr-part-row"><span className="k">Node</span><span className="v mono dim">{shortHash(pillar.node_hash)}<CopyChip value={pillar.node_hash} label="node hash" /></span></div>
                <div className="pr-part-row"><span className="k">Meta</span><span className="v mono dim">{shortHash(pillar.meta_hash)}<CopyChip value={pillar.meta_hash} label="meta hash" /></span></div>
              </div>
            </div>
          )}

          <div className="pr-part is-topic">
            <div className="pr-part-head"><span className="pr-part-badge">{pillar ? 'Founding topic' : 'Topic'}</span><span className="pr-part-flag">deeper</span></div>
            {topic ? (
              <>
                <h3 className="pr-part-title">{topic.title}</h3>
                {topic.blurb && <p className="pr-part-blurb">{topic.blurb}</p>}
                <div className="pr-part-rows">
                  <div className="pr-part-row"><span className="k">Label</span><span className="v mono">{topic.id}<CopyChip value={topic.id} label="topic slug" /></span></div>
                  <div className="pr-part-row"><span className="k">Under</span><span className="v">{parentPillar?.title || '—'}</span></div>
                  <div className="pr-part-row"><span className="k">Node</span><span className="v mono dim">{shortHash(topic.node_hash)}<CopyChip value={topic.node_hash} label="node hash" /></span></div>
                  <div className="pr-part-row"><span className="k">Meta</span><span className="v mono dim">{shortHash(topic.meta_hash)}<CopyChip value={topic.meta_hash} label="meta hash" /></span></div>
                </div>
              </>
            ) : <p className="pr-part-empty">Founding topic loading…</p>}
          </div>

          <div className="pr-part is-evidence">
            <div className="pr-part-head">
              <span className="pr-part-badge">Founding evidence</span>
              {evidence && <span className="pr-part-flag">Tier {tierRoman(evidence.tier)} · {evidence.type || tierWord(evidence.tier)}</span>}
            </div>
            {evidence ? (
              <>
                <h3 className="pr-part-title is-clickable" role="button" tabIndex={0}
                  onClick={openEvidence}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEvidence(); } }}
                  title="Open the full evidence record">{evidence.title}</h3>
                {(evidence.source || evidence.year) && <p className="pr-part-src">{evidence.source}{evidence.year ? <> · <span className="yr">{evidence.year}</span></> : null}</p>}
                {evidence.excerpt && <p className="pr-part-excerpt">{evidence.excerpt}</p>}
                <div className="pr-part-rows">
                  <div className="pr-part-row"><span className="k">Evidence id</span><span className="v mono dim">{shortHash(evidence.evidenceId)}<CopyChip value={evidence.evidenceId} label="evidence id" /></span></div>
                  <div className="pr-part-row"><span className="k">Content</span><span className="v mono dim">{shortHash(evidence.content_hash)}<CopyChip value={evidence.content_hash} label="content hash" /></span></div>
                  {evidence.link && <div className="pr-part-row"><span className="k">Source</span><span className="v"><a href={evidence.link} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>Open link ↗</a></span></div>}
                </div>
                <button type="button" className="pr-part-viewfull" onClick={openEvidence}>View full record →</button>
              </>
            ) : <p className="pr-part-empty">Founding evidence loading…</p>}
          </div>
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
      {retireSign && (
        <SignModal
          payload={{
            action: 'retire_node',
            title: retireSign.mode === 'motion' ? 'Motion to retire topic' : 'Vote to retire topic',
            evidenceTitle: retireSign.node.title,
            sub: retireSign.mode === 'motion'
              ? 'Open a retire motion — you are retire vote #1. Retiring a topic needs a 2/3 supermajority.'
              : 'Add your vote to the open retire motion.',
            verdict: 'retire',
          }}
          onCancel={() => setRetireSign(null)}
          onSign={runRetire}
        />
      )}
      {preview && <EvidencePreviewModal b={preview} onClose={() => setPreview(null)} />}
    </section>
  );
}

// ── Peer registry tab ────────────────────────────────────────────────────────
// Segmented switch at the top of the Peer registry tab: the live roster vs. the
// searchable registry vote history (RegistryLog).
function RegistryViewToggle({ view, onChange }) {
  return (
    <div className="pr-queue-toggle" role="tablist">
      <button role="tab" aria-selected={view === 'registry'} className={view === 'registry' ? 'is-active' : ''} onClick={() => onChange('registry')}>Registry</button>
      <button role="tab" aria-selected={view === 'history'} className={view === 'history' ? 'is-active' : ''} onClick={() => onChange('history')}>Vote history</button>
    </div>
  );
}

function PeersTab({ me, peerCount, onNominate, onSeed, reloadSignal, setToast, onPeerHistory, onRevocationChange }) {
  const [peers, setPeers] = useState([]);
  const [nominees, setNominees] = useState([]);
  const [seedK, setSeedK] = useState(0);
  const [owner, setOwner] = useState(null);
  const [nomOpen, setNomOpen] = useState(true);
  const [nomThreshold, setNomThreshold] = useState(1);
  const [revThreshold, setRevThreshold] = useState(1);
  // Off-chain keep state, keyed by subject addr: { rounds, myKeeps (Set
  // `addr:round`), keepCounts } for the peers currently under revocation.
  const [revKeep, setRevKeep] = useState({ rounds: {}, myKeeps: new Set(), keepCounts: {} });
  const [q, setQ] = useState('');
  const [view, setView] = useState('registry');   // 'registry' roster | 'history' vote log
  const [vote, setVote] = useState(null);         // pending membership vote (note-capture modal)
  const [fr, setFr] = useState({ active: false, votes: 0, threshold: 1 }); // force-renounce state

  const load = useCallback(async () => {
    if (!CONSENSUS_ADDR) return;
    const [p, n, k, own, open, thr, revThr] = await Promise.all([getActivePeersAggregated(), getNomineesAggregated(), getSeedPhaseK(), getOwner(), isNominationsOpen(), getNomineeThreshold(), getRevokeThreshold()]);
    if (own && own !== '0x0000000000000000000000000000000000000000') {
      const [frA, frV, frT] = await Promise.all([getForceRenounceActive(), getForceRenounceVotes(), getRetireThreshold()]);
      setFr({ active: !!frA, votes: Number(frV) || 0, threshold: Number(frT) || 1 });
    } else {
      setFr({ active: false, votes: 0, threshold: 1 });
    }
    let mineRevoke = new Map();
    if (me) mineRevoke = await hasVotedForRevokeMany(p.map(x => x.addr), me.addr);
    const nomEnriched = me ? await Promise.all(n.map(async x => ({ ...x, mine: await hasEndorsedNominee(x.addr, me.addr) }))) : n;
    setPeers(p.map(x => ({ ...x, iVoted: mineRevoke.get(x.addr) })));
    setNominees(nomEnriched);
    setSeedK(Number(k) || 0);
    setOwner(own ? String(own).toLowerCase() : null);
    setNomOpen(!!open);
    setNomThreshold(Number(thr) || 1);
    setRevThreshold(Number(revThr) || 1);

    // Off-chain keep positions for the peers currently under revocation.
    const revPeers = p.filter(x => x.revActive);
    if (revPeers.length) {
      const roundsArr = await Promise.all(revPeers.map(x => getRevokeRound(x.addr)));
      const rounds = {}; revPeers.forEach((x, i) => { rounds[x.addr] = roundsArr[i]; });
      const [myKeeps, keepCounts] = await Promise.all([
        me ? fetchMyRevocationKeeps(me.addr) : new Set(),
        fetchRevocationKeepCounts(rounds),
      ]);
      setRevKeep({ rounds, myKeeps, keepCounts });
    } else {
      setRevKeep({ rounds: {}, myKeeps: new Set(), keepCounts: {} });
    }
  }, [me]);
  // reloadSignal bumps after a seed/nominate so the list + open-state refresh.
  useEffect(() => { load(); }, [load, reloadSignal]);

  const afterRevChange = () => { load(); onRevocationChange?.(); };
  const prune   = async (addr) => { try { await waitForTx(await pruneInactivePeerOnChain(addr)); setToast({ type: 'info', msg: 'Inactive peer pruned' }); load(); } catch (e) { setToast({ type: 'err', msg: e?.message || 'Failed' }); } };

  // Membership votes now open a sign modal that captures an optional deliberation
  // note, then: sign the EIP-712 PeerVote (recovered on-chain), submit the vote,
  // and persist the note + signature off-chain so the registry vote history can
  // show it. The off-chain note write is best-effort — the on-chain vote stands
  // even if it fails (the indexer still records the vote event).
  const endorse = (n) => setVote({
    title: 'Endorse nominee', sub: `${n.handle || SHORT(n.addr)} · verify as a peer`, verdict: 'approve',
    onSubmit: async (note) => {
      const { txHash, sig, round } = await endorseNomineeOnChain(n.addr, note);
      await waitForTx(txHash);
      try { await castNomineeEndorse({ nomineeAddr: n.addr, voterAddr: me.addr, round, note, sig }); }
      catch (e) { console.warn('Endorse note write failed (vote stands):', e); }
      setToast({ type: 'info', msg: 'Endorsed nominee' }); load();
    },
  });
  const motion = (p) => setVote({
    title: 'Motion to revoke', sub: `${p.handle || SHORT(p.addr)} · open a discard vote`, verdict: 'reject',
    onSubmit: async (note) => {
      const { txHash, sig, round } = await motionRevokeOnChain(p.addr, note);
      await waitForTx(txHash);
      try { await castRevocationDiscard({ subjectAddr: p.addr, voterAddr: me.addr, round, note, sig }); }
      catch (e) { console.warn('Motion note write failed (vote stands):', e); }
      setToast({ type: 'info', msg: 'Revocation motioned' }); afterRevChange();
    },
  });
  const voteRev = (p) => setVote({
    title: 'Vote to discard', sub: `${p.handle || SHORT(p.addr)} · remove from the peer set`, verdict: 'reject',
    onSubmit: async (note) => {
      const { txHash, sig, round } = await voteRevokeOnChain(p.addr, note);
      await waitForTx(txHash);
      try { await castRevocationDiscard({ subjectAddr: p.addr, voterAddr: me.addr, round, note, sig }); }
      catch (e) { console.warn('Discard note write failed (vote stands):', e); }
      setToast({ type: 'info', msg: 'Voted to discard' }); afterRevChange();
    },
  });
  // "Keep" has no on-chain call — sign an EIP-712 Attestation dissent bound to the
  // current round and record it off-chain via the revocation-vote edge function.
  const voteKeep = (p) => setVote({
    title: 'Vote to keep', sub: `${p.handle || SHORT(p.addr)} · defend against revocation`, verdict: 'defend',
    onSubmit: async (note) => {
      const round = revKeep.rounds[p.addr] ?? await getRevokeRound(p.addr);
      const sig = await signAttestation({ evidenceId: String(round), topicId: p.addr.toLowerCase(), phase: 'revocation', verdict: 'keep', note }, me.addr);
      await castRevocationKeep({ subjectAddr: p.addr, voterAddr: me.addr, round, note, sig });
      setToast({ type: 'info', msg: 'Voted to keep' }); afterRevChange();
    },
  });
  // Force-renounce — the peer-supermajority escape hatch that strips a
  // captured/paused owner. By-sig (Vote phase 4); the note rides in the signed
  // noteHash. Reuses the membership note-capture modal.
  const forceRenounce = () => setVote({
    title: fr.active ? 'Vote to force-renounce owner' : 'Motion to force-renounce owner',
    sub: `Strip the owner entirely (and unpause). Passes at ${fr.threshold} of ${peerCount} peers (2/3).`,
    verdict: 'reject',
    onSubmit: async (note) => {
      const res = fr.active ? await voteForceRenounce(note) : await motionForceRenounce(note);
      await waitForTx(res.txHash);
      try {
        await castGovNote({
          kind: 'force_renounce', subject: res.bindingHash, verdict: 'renounce',
          round: res.round, note, noteHash: res.noteHash, sig: res.sig, txHash: res.txHash,
          peerAddr: me.addr, peerHandle: me.handle,
        });
      } catch (e) { console.warn('Force-renounce note write failed (vote stands):', e); }
      setToast({ type: 'info', msg: fr.active ? 'Force-renounce vote cast' : 'Force-renounce motioned' }); load();
    },
  });

  // Mirror the contract's INACTIVITY_WINDOW (30 days). A peer idle past it can be
  // pruned by anyone, but never below the seed-phase floor.
  const INACTIVITY_SECS = 30 * 86400;
  const aboveFloor = (peerCount ?? peers.length) > seedK;
  // Prefer the freshly-loaded peer list length over the (possibly stale) prop.
  const effCount = peers.length || (peerCount ?? 0);
  const isOwner  = !!(me && owner && me.addr.toLowerCase() === owner);

  const ql = q.trim().toLowerCase();
  const fp = peers.filter(p => !ql || (p.handle || '').toLowerCase().includes(ql) || p.addr.includes(ql));
  const fn = nominees.filter(p => !ql || (p.handle || '').toLowerCase().includes(ql) || p.addr.includes(ql));

  // Registry order: you first, then peers under active revocation, then open
  // nominees, then the rest of the verified set. `filter` preserves the
  // contract's returned order within each group.
  const isMineAddr   = (p) => !!(me && p.addr === me.addr.toLowerCase());
  const youPeers     = fp.filter(isMineAddr);
  const revokingPeers = fp.filter(p => !isMineAddr(p) && p.revActive);
  const restPeers    = fp.filter(p => !isMineAddr(p) && !p.revActive);

  const renderNominee = (n) => (
    <article className="pr-registry-card" key={n.addr}>
      <Jazz addr={n.addr} size={48} />
      <div>
        <div className="handle">{n.handle || SHORT(n.addr)} <span className="pill pill--pending" style={{ fontSize: 9 }}><span className="dot" />Nominee</span></div>
        <div className="addr">{SHORT(n.addr)}</div>
      </div>
      <div className="meta">
        <span><b>{n.endorsements}</b>of {nomThreshold} to verify</span>
        {me && (n.mine ? <span style={{ opacity: 0.6 }}>✓ endorsed</span> : <button className="btn btn--accent btn--xs" onClick={() => endorse(n)}>+ Endorse</button>)}
      </div>
    </article>
  );

  const renderPeer = (p) => {
    const isMe = isMineAddr(p);
    const prunable = p.lastActive && (Date.now() / 1000 - p.lastActive) > INACTIVITY_SECS && aboveFloor;
    return (
      <article className="pr-registry-card" key={p.addr}>
        <Jazz addr={p.addr} size={48} />
        <div>
          <div className="handle">{p.handle || SHORT(p.addr)} {isMe && <span className="pill" style={{ fontSize: 9, color: 'var(--accent)' }}>YOU</span>}{p.revActive && <span className="pill pill--contested" style={{ fontSize: 9 }}><span className="dot" />Revoking</span>}{prunable && <span className="pill pill--contested" style={{ fontSize: 9 }}><span className="dot" />Inactive</span>}</div>
          <div className="addr" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{SHORT(p.addr)}<CopyChip value={p.addr} label="address" /></div>
          {prunable && <div className="addr" style={{ opacity: 0.7 }}>prunable</div>}
          {onPeerHistory && (
            <button type="button" className="pr-peer-history" onClick={() => onPeerHistory(p.addr)} title="View this peer's signed vote history">
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l3 1.5" /></svg>
              History
            </button>
          )}
        </div>
        <div className="meta">
          {prunable && !isMe && <button className="btn btn--danger btn--xs" onClick={() => prune(p.addr)} title="Remove a peer idle past 30 days">Prune inactive</button>}
          {p.revActive
            ? (() => {
                const kept = revKeep.myKeeps.has(`${p.addr}:${revKeep.rounds[p.addr]}`);
                const keepCount = revKeep.keepCounts[p.addr] || 0;
                return (
                  <>
                    <span><b>{p.revVotes}</b> of {revThreshold} to discard</span>
                    <span><b>{keepCount}</b> to keep</span>
                    {me && !isMe && (
                      p.iVoted ? <span style={{ opacity: 0.6 }}>✓ voted to discard</span>
                      : kept ? <span style={{ opacity: 0.6 }}>✓ voted to keep</span>
                      : (
                        <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                          <button className="btn btn--accent btn--xs" onClick={() => voteKeep(p)} title="Sign a keep vote — record your support off-chain">Vote keep</button>
                          <button className="btn btn--danger btn--xs" onClick={() => voteRev(p)} title="Sign + cast an on-chain discard vote">Vote discard</button>
                        </div>
                      )
                    )}
                  </>
                );
              })()
            : (me && !isMe && <button className="btn btn--ghost btn--xs" onClick={() => motion(p)}>Motion revoke</button>)}
        </div>
      </article>
    );
  };

  return (
    <section>
      <RegistryViewToggle view={view} onChange={setView} />

      {view === 'history' ? (
        <RegistryLog />
      ) : (
        <>
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
              {me && nomOpen && <button className="btn btn--primary btn--sm" onClick={onNominate}>+ Nominate peer</button>}
              {me && !nomOpen && isOwner && <button className="btn btn--primary btn--sm" onClick={onSeed}>+ Seed peer</button>}
            </div>
          </div>

          {!nomOpen && (
            <div className="pr-seed-note">
              <b>Seed phase — {effCount} of {seedK} peers.</b>{' '}
              {isOwner
                ? 'Nominations are closed until the seed quorum is reached. As owner, use “Seed peer” to add the founding peers directly — each becomes active immediately. The endorsement-based nominate flow opens automatically at the quorum.'
                : 'Nominations are closed until the network owner has seeded the founding peers. The endorsement-based nominate flow opens automatically once the quorum is reached.'}
            </div>
          )}

          {me && !isOwner && owner && (
            <div className="pr-seed-note">
              <b>Owner force-renounce.</b>{' '}
              {fr.active
                ? `A motion to strip the owner is open — ${fr.votes} of ${fr.threshold} peers (2/3). `
                : 'The escape hatch: a 2/3 peer supermajority can strip a captured or paused owner. '}
              <button className="btn btn--danger btn--xs" onClick={forceRenounce} style={{ marginLeft: 6 }}>
                {fr.active ? 'Vote to force-renounce' : 'Motion to force-renounce'}
              </button>
            </div>
          )}

          <div className="pr-registry">
            {youPeers.map(renderPeer)}
            {revokingPeers.map(renderPeer)}
            {fn.map(renderNominee)}
            {restPeers.map(renderPeer)}
          </div>
          {fp.length === 0 && fn.length === 0 && <div className="pr-empty"><h3>No peers found</h3><p>Try a different search.</p></div>}
        </>
      )}

      {vote && <PeerVoteModal payload={vote} onClose={() => setVote(null)} setToast={setToast} />}
    </section>
  );
}

// ── Peer membership vote modal (note-capture + sign) ─────────────────────────
//
// Membership votes (endorse / discard / keep) are EIP-712-signed with an optional
// deliberation note. This captures the note, then runs the caller's onSubmit —
// which signs, casts the vote, and records the note off-chain — closing on
// success. 4001 (user-rejected signature) closes quietly; other errors toast.
function PeerVoteModal({ payload, onClose, setToast }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const v = VERDICT_STYLE[payload.verdict];
  const submit = async () => {
    setBusy(true);
    try { await payload.onSubmit(note.trim()); onClose(); }
    catch (e) { if (e?.code !== 4001) setToast({ type: 'err', msg: e?.message || 'Vote failed' }); }
    finally { setBusy(false); }
  };
  return createPortal(
    <div className="pr-modal-scrim" onClick={busy ? undefined : onClose}>
      <div className="pr-modal" onClick={e => e.stopPropagation()}>
        <h3>{payload.title}</h3>
        {payload.sub && <p className="sub">{payload.sub}</p>}
        {v && (
          <div className="pr-vote-verdict">
            <span className="lab">Verdict</span>
            <span className="val" style={{ color: v.color }}>{v.label}</span>
          </div>
        )}
        <div className="field">
          <label>Deliberation note (optional)</label>
          <textarea rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="Why this verdict…" />
        </div>
        <div className="pr-modal-actions">
          <button className="btn btn--ghost btn--sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn--primary btn--sm" onClick={submit} disabled={busy}>{busy ? 'Signing…' : 'Sign & submit'}</button>
        </div>
      </div>
    </div>,
    document.body,
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

// "Pillar · Topic" column header with a subtle "?" explaining the colour key:
// solid = ratified canon node, amber italic = a node this vote is proposing that
// isn't in the canon taxonomy yet. Reuses the System-health hint popover pattern.
function ColorKeyHint() {
  const [open, setOpen] = useState(false);
  return (
    <span className="pr-log-th-hint">
      Pillar · Topic
      <button
        type="button"
        className="pr-hint-btn"
        aria-label="What the Pillar · Topic colours mean"
        aria-expanded={open}
        title="What the colours mean"
        onClick={() => setOpen(v => !v)}
      >?</button>
      {open && (
        <>
          <div className="pr-hint-scrim" onClick={() => setOpen(false)} />
          <div className="pr-hint-pop pr-hint-pop--left" role="dialog" aria-label="Pillar · Topic colour key">
            <strong>Pillar · Topic colour key</strong>
            <p>
              <b className="pr-key-swatch is-canon">White</b> — a pillar or topic
              that already exists in the canon taxonomy (ratified on-chain).
            </p>
            <p>
              <b className="pr-key-swatch is-proposed">Amber</b> — a pillar or topic
              this vote is <em>proposing</em>. Proposing a node is itself a vote, so
              it shows here before the node exists; it joins the canon only once the
              proposal ratifies. A new pillar marks both itself and its founding
              topic; a new topic under an existing pillar marks only the topic.
            </p>
            <p>
              <b className="pr-key-swatch is-retired">Red</b> — a pillar or topic that
              was <em>retired</em> off the canon taxonomy. The vote stays in the
              record; the struck-through name shows the node no longer exists.
            </p>
          </div>
        </>
      )}
    </span>
  );
}

// One row of the vote history. Holds local state for the optional deliberation
// note: a peer may attach a note when voting, so the reveal toggle only renders
// when one exists, expanding a full-width panel beneath the row.
function LogRow({ r, tax, onOpen, handleMap, onLinkback }) {
  const [showNote, setShowNote] = useState(false);
  const note = (r.note || '').trim();
  // Network outcome rows (binding canonized/expelled/lapsed/deprecated/reaffirmed,
  // node ratified/retired) carry no peer — they're emitted by the contract when
  // consensus is reached, and surface here with peer_addr=null + peer_handle='Network'.
  const isNetworkRow = !r.peer_addr && r.peer_handle === 'Network';
  const peerName = r.peer_handle || handleMap[r.peer_addr?.toLowerCase()] || SHORT(r.peer_addr);

  // Pillar · Topic cell. A taxonomy proposal IS a vote, so its row flags the
  // pillar/topic it introduced as "not yet ratified" — and keeps flagging it after
  // a single-peer proposal instant-ratifies. Two durable signals:
  //   • the node is still 'proposed' (multi-peer, pre-ratification), or
  //   • this row is the taxonomy vote whose tx first proposed the node, matched by
  //     the propose_tx the indexer stamps on the node.
  // A pillar bundle stamps only the pillar (its founding topic emits no
  // PillarProposed of its own), so the founding topic rides the pillar's flag.
  const isTaxonomyVote = r.phase === 'taxonomy';
  const rowTx = (r.tx_hash || '').toLowerCase();
  const proposedHere = (n) => isTaxonomyVote && !!rowTx && (n?.propose_tx || '').toLowerCase() === rowTx;

  const ratifiedPillar = tax.pillarMap[r.pillar_id];
  const proposedPillar = tax.proposedPillarMap?.[r.pillar_id];
  // r.pillar_title (from the view) is the durable fallback so a RETIRED pillar —
  // which drops out of the ratified-only taxonomy cache — still shows its name.
  const pillarTitle    = ratifiedPillar?.title || proposedPillar?.title || r.pillar_title || null;
  const pillarPending  = !!proposedPillar || proposedHere(ratifiedPillar);
  // Retired = the node row still exists (the view resolved its title) but it's
  // neither ratified (in the cache) nor proposed → it was retired off the canon.
  const pillarRetired  = !ratifiedPillar && !proposedPillar && !!r.pillar_title;

  const ratifiedTopic = tax.topicMap[r.topic_id];
  const proposedTopic = tax.proposedTopicMap?.[r.topic_id];
  const topicTitle    = ratifiedTopic?.title || r.topic_title || proposedTopic?.title || null;
  const topicPending  = !!proposedTopic || proposedHere(ratifiedTopic) || pillarPending;
  const topicRetired  = !ratifiedTopic && !proposedTopic && !!r.topic_title;

  return (
    <div className={`pr-log-row ${showNote ? 'is-noted' : ''} ${r.derived ? 'is-derived' : ''}`}>
      <span className="t">{ago(r.created_at)}</span>
      <span className={`verdict ${displayVerdict(r.verdict)}`}>{r.derived ? 'Consensus reject' : displayVerdict(r.verdict)}</span>
      <span className="pillar">
        <span
          className={`pr-log-node ${pillarRetired ? 'is-retired' : pillarPending ? 'is-proposed' : ''}`}
          title={pillarRetired ? 'Retired pillar — no longer in the canon taxonomy' : pillarPending ? 'Proposed pillar — not yet ratified' : undefined}
        >{pillarTitle || '—'}</span>
        {topicTitle && (
          <>
            <span className="pr-log-node-sep" aria-hidden="true">·</span>
            <span
              className={`pr-log-node ${topicRetired ? 'is-retired' : topicPending ? 'is-proposed' : ''}`}
              title={topicRetired ? 'Retired topic — no longer in the canon taxonomy' : topicPending ? 'Proposed topic — not yet ratified' : undefined}
            >{topicTitle}</span>
          </>
        )}
      </span>
      <span className="title">
        {r.evidence_title
          ? <button type="button" className="pr-log-evi" onClick={() => onOpen(r)} title="Open the full evidence record">{r.evidence_title}</button>
          : '—'}
      </span>
      <span className="peer-cell">
        {isNetworkRow ? (
          <span
            className="pr-log-network"
            title={r.derived
              ? `Derived consensus outcome — computed from ${r.derived_dissents} signed dissents (no on-chain reject exists for taxonomy proposals).`
              : 'Network consensus outcome — the chain emitted this when the vote tally crossed threshold'}
          >
            <span className="pr-log-network-dot" aria-hidden="true" />
            Network
          </span>
        ) : (
          <>
            <Jazz addr={r.peer_addr} size={22} />{peerName}<CopyChip value={r.peer_addr} label="peer address" />
          </>
        )}
      </span>
      <span className="detail">
        {note
          ? (
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
          )
          : <span style={{ color: 'var(--ink-faint)' }}>—</span>}
      </span>
      <span className="tx"><AttestationVerifier a={r} handle={peerName} onLinkback={onLinkback} handleMap={handleMap} /></span>
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

function LogTab({ initialQuery = '', peerCount }) {
  const [q, setQ] = useState(initialQuery);
  const [debounced, setDebounced] = useState(initialQuery);
  const [verdict, setVerdict] = useState('');
  const [pillar, setPillar] = useState('');
  const [preview, setPreview] = useState(null);
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  const { log, loading, hasMore, loadMore, total } = useAttestationLog(30, debounced, verdict);
  // Synthetic "Network rejected by consensus" rows derived from the signed
  // reject_node attestations — the contract has no on-chain reject for taxonomy
  // proposals, so the public log gets a clearly-labelled Derived row at the
  // moment cumulative dissents make ratification arithmetically impossible.
  const derived = useDerivedConsensusRejects(peerCount, debounced, verdict);
  const tax = useTaxonomy();
  const handleMap = usePeerHandleMap();
  // Merge derived rows with the loaded page and re-sort by time. Pillar filter
  // applies to both — derived rows carry the same pillar_id as the underlying
  // dissents. The total stat counts only real signed votes; derived rows are a
  // projection of those, not a separate vote.
  const merged = useMemo(() => {
    const all = [...derived, ...log];
    return all.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  }, [derived, log]);
  const shown = pillar ? merged.filter(r => r.pillar_id === pillar) : merged;

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
        <div className="pr-log-row is-head"><span>When</span><span>Verdict</span><ColorKeyHint /><span>Evidence</span><span>Peer</span><span>Note</span><span>Proof</span></div>
        {shown.map(r => <LogRow key={r.id} r={r} tax={tax} onOpen={openPreview} handleMap={handleMap} onLinkback={(term) => { setQ(term); setDebounced(term); }} />)}
        {!loading && shown.length === 0 && <div className="pr-log-row"><span style={{ gridColumn: '1 / -1', color: 'var(--ink-faint)' }}>No attestations match.</span></div>}
      </div>
      <div className="pr-log-foot">
        {hasMore && <button className="btn btn--ghost btn--sm" onClick={loadMore} disabled={loading}>{loading ? 'Loading…' : 'Load 30 more'}</button>}
      </div>
      {preview && <EvidencePreviewModal b={preview} onClose={() => setPreview(null)} statusLabel={null} />}
    </section>
  );
}

// ── Peer registry voting log ─────────────────────────────────────────────────
//
// The registry-scoped sibling of the evidence Vote history (LogTab): a
// searchable, paginated stream of every governance vote and lifecycle event on
// the named peer set (usePeerRegistryLog), reached via the toggle at the top of
// the Peer Registry tab. Each row's Proof column opens RegistryProofVerifier —
// recovering the PeerVote signer in-browser (a "keep" dissent recovers its core
// Attestation instead), with sig-less lifecycle outcomes leaning on the tx.
const REGISTRY_KIND_TABS  = ['', 'endorse', 'discard', 'keep'];
const REGISTRY_KIND_LABEL = { '': 'All', endorse: 'Endorse', discard: 'Discard', keep: 'Keep' };
// action → display label + the verdict colour class it reuses from the log CSS.
const REG_ACTION = {
  nominate:   { label: 'Nominate',   cls: 'endorse'   },
  endorse:    { label: 'Endorse',    cls: 'approve'   },
  verified:   { label: 'Verified',   cls: 'approve'   },
  lapsed:     { label: 'Timeout',    cls: 'reject'    },  // NomineeLapsed — window expired without enough endorsements
  motion:     { label: 'Motion',     cls: 'challenge' },
  discard:    { label: 'Discard',    cls: 'reject'    },
  keep:       { label: 'Keep',       cls: 'defend'    },
  cancelled:  { label: 'Timeout',    cls: 'defend'    },  // RevocationCancelled — cancelStaleRevocation GC after window expires without enough discards
  revoked:    { label: 'Revoked',    cls: 'reject'    },
  seeded:     { label: 'Seeded',     cls: 'endorse'   },  // PeerAdded with no NomineeVerified twin — owner seed
  inactivity: { label: 'Inactivity', cls: 'reject'    },  // PeerRemoved with no PeerRevoked twin — pruneInactivePeer
};

function RegistryLogRow({ r, handleMap, onLinkback }) {
  const [showNote, setShowNote] = useState(false);
  const subjName  = r.subjectHandle || handleMap[r.subjectAddr?.toLowerCase()] || SHORT(r.subjectAddr);
  const actorName = r.actorAddr ? (handleMap[r.actorAddr.toLowerCase()] || SHORT(r.actorAddr)) : null;
  const act  = REG_ACTION[r.action] || { label: r.action, cls: '' };
  const note = (r.note || '').trim();
  return (
    <div className={`pr-log-row is-registry ${showNote ? 'is-noted' : ''}`}>
      <span className="t">{ago(r.ts)}</span>
      <span className={`verdict ${act.cls}`}>{act.label}</span>
      <span className="peer-cell">
        {r.subjectAddr
          ? <><Jazz addr={r.subjectAddr} size={22} />{subjName}<CopyChip value={r.subjectAddr} label="peer address" /></>
          : '—'}
      </span>
      <span className="peer-cell">
        {actorName
          ? <><Jazz addr={r.actorAddr} size={22} />{actorName}<CopyChip value={r.actorAddr} label="actor address" /></>
          : (
            <span className="pr-log-network" title="Network consensus outcome — the chain emitted this when the vote tally crossed threshold">
              <span className="pr-log-network-dot" aria-hidden="true" />
              Network
            </span>
          )}
      </span>
      <span className="detail">
        {note
          ? (
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
          )
          : <span style={{ color: 'var(--ink-faint)' }}>—</span>}
      </span>
      <span className="tx"><RegistryProofVerifier r={r} actorName={actorName} actionLabel={act.label} onLinkback={onLinkback} handleMap={handleMap} /></span>
      {note && showNote && (
        <div className="pr-log-note">
          <span className="pr-log-note-label">Deliberation note</span>
          <p>{note}</p>
        </div>
      )}
    </div>
  );
}

function RegistryLog() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [kind, setKind] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  const { log, loading, hasMore, loadMore, total } = usePeerRegistryLog(30, debounced, kind);
  const handleMap = usePeerHandleMap();
  const onLinkback = (term) => { setQ(term); setDebounced(term); };

  return (
    <section>
      <div className="pr-tab-head">
        <div>
          <span className="eyebrow">Registry vote history · searchable</span>
          <h2 style={{ marginTop: 10 }}><em>{total ?? log.length}</em> registry {(total ?? log.length) === 1 ? 'action' : 'actions'}</h2>
        </div>
      </div>

      <div className="pr-log-controls is-registry">
        <div className="search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search by peer handle, address, or tx hash" />
        </div>
        <div className="tabs">
          {REGISTRY_KIND_TABS.map(v => (
            <button key={v || 'any'} className={kind === v ? 'is-active' : ''} onClick={() => setKind(v)}>{REGISTRY_KIND_LABEL[v]}</button>
          ))}
        </div>
      </div>

      <div className="pr-log is-registry">
        <div className="pr-log-row is-registry is-head"><span>When</span><span>Action</span><span>Peer</span><span>By</span><span>Note</span><span>Proof</span></div>
        {log.map(r => <RegistryLogRow key={r.id} r={r} handleMap={handleMap} onLinkback={onLinkback} />)}
        {!loading && log.length === 0 && <div className="pr-log-row"><span style={{ gridColumn: '1 / -1', color: 'var(--ink-faint)' }}>No registry votes match.</span></div>}
      </div>
      <div className="pr-log-foot">
        {hasMore && <button className="btn btn--ghost btn--sm" onClick={loadMore} disabled={loading}>{loading ? 'Loading…' : 'Load 30 more'}</button>}
      </div>
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
  const [showHint, setShowHint] = useState(false);
  return (
    <div className={`pr-gate ${allCleared ? 'is-clear' : ''}`} role="status" aria-label="Batch clear-all gate">
      <div className="pr-gate-head">
        <span className="pr-health-hint">
          <span className="pr-gate-eyebrow">Batch gate</span>
          <button
            type="button"
            className="pr-hint-btn"
            aria-label="Why the batch gate"
            aria-expanded={showHint}
            title="Why the batch gate"
            onClick={() => setShowHint(v => !v)}
          >?</button>
          {showHint && (
            <>
              <div className="pr-hint-scrim" onClick={() => setShowHint(false)} />
              <div className="pr-hint-pop pr-hint-pop--left" role="dialog" aria-label="Batch gate philosophy">
                <strong>One queue. One pace. One consensus.</strong>
                <p>Every peer works the <em>same</em> review, challenge, and taxonomy queues, in the same order. The gate keeps the three surfaces in lockstep — your next batch loads only once you've cleared the current one on every surface.</p>
                <p>Without it, a peer racing through one surface while skipping the others would let their preferred claims canonize on a thinner quorum while harder questions sat unjudged. The gate makes that impossible: every claim earns a verdict from the same peers, in the same window, so consensus is <em>always</em> reachable — never a side-effect of who showed up where.</p>
              </div>
            </>
          )}
        </span>
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

// Open peer-revocations this peer still owes a position on (keep or discard).
// Discard is read on-chain (hasVotedRevoke); keep off-chain (revocation_votes).
// Feeds the unified batch gate so the network must resolve every open revocation
// and move on, rather than letting a motion linger to its 14-day expiry. The
// targeted peer is excluded — a peer can't vote on their own revocation.
function useRevocationGate(me) {
  const [open, setOpen]   = useState([]);            // [{ addr, round }]
  const [acted, setActed] = useState(() => new Set());

  const refetch = useCallback(async () => {
    if (!CONSENSUS_ADDR || !me) { setOpen([]); setActed(new Set()); return; }
    const meLower = me.addr.toLowerCase();
    const peers = await getActivePeersAggregated();
    const rev = peers.filter(p => p.revActive && p.addr !== meLower);
    if (!rev.length) { setOpen([]); setActed(new Set()); return; }
    const rounds = await Promise.all(rev.map(p => getRevokeRound(p.addr)));
    const list = rev.map((p, i) => ({ addr: p.addr, round: rounds[i] }));
    const [discardMap, myKeeps] = await Promise.all([
      hasVotedForRevokeMany(list.map(x => x.addr), me.addr),
      fetchMyRevocationKeeps(me.addr),
    ]);
    const actedSet = new Set();
    for (const x of list) if (discardMap.get(x.addr) || myKeeps.has(`${x.addr}:${x.round}`)) actedSet.add(x.addr);
    setOpen(list); setActed(actedSet);
  }, [me]);
  useEffect(() => { refetch(); }, [refetch]);

  const pendingForMe = open.filter(x => !acted.has(x.addr)).length;
  return { open, pendingForMe, cleared: pendingForMe === 0, refetch };
}

// ── Verified workspace ───────────────────────────────────────────────────────
function VerifiedWorkspace({ me, isGenesis, peerCount, setToast }) {
  const [tab, setTab] = useState('queue');
  const [logQuery, setLogQuery] = useState('');
  const seeHistory = (b) => { setLogQuery(b.id); setTab('log'); };
  const seePeerHistory = (addr) => { setLogQuery(addr); setTab('log'); };
  const [pendingSign, setPendingSign] = useState(null);
  const [showPropose, setShowPropose] = useState(false);
  const [showNominate, setShowNominate] = useState(false);
  const [showSeed, setShowSeed] = useState(false);
  const [reloadPeers, setReloadPeers] = useState(0);
  const [chainPending, setChainPending] = useState(null);
  const [cooldown, setCooldown] = useState(0);
  const [preview, setPreview] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingCh, setRefreshingCh] = useState(false);
  const [queueView, setQueueView] = useState('needs');   // 'needs' | 'open'
  const [chQueueView, setChQueueView] = useState('needs');
  const [beating, setBeating] = useState(false);
  const [showBeatHint, setShowBeatHint] = useState(false);

  const { queue, refetch: refetchQueue } = usePendingBindings();
  const { contested, refetch: refetchContested } = useContestedBindings();
  const { queue: queued, refetch: refetchQueued } = useQueuedBindings();
  const reviewCount = useMyReviewCount(me?.addr);
  // Shared taxonomy-proposal state — also drives the unified clear-all gate, so
  // it lives here and is passed down to the Taxonomy tab (one source of truth).
  const taxReview = useTaxonomyReview(me);
  const revGate = useRevocationGate(me);

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
    try { await Promise.all([refetchQueue(), refetchQueued()]); }
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

  // Authoritative voted-detection from each binding's OWN attestations (the queue
  // fetches them via `attestations(*)`). The on-chain reads above can lag behind
  // the write or be absent on a fresh load, which would briefly show an
  // already-voted binding as votable again; the off-chain attestation projection
  // is lag-free and realtime-refreshed, so a binding this peer has attested to is
  // never offered for a second vote. Idempotent — only sets when something new
  // appears, so it can't loop.
  useEffect(() => {
    if (!me || !queue.length) return;
    const addr = me.addr.toLowerCase();
    const voted = queue.filter(b => b.attestations?.some(a => a.phase === 'review' && a.peer_addr?.toLowerCase() === addr)).map(b => b.bindingId);
    if (!voted.length) return;
    setMyVotes(prev => {
      if (voted.every(id => prev[id])) return prev;
      const next = { ...prev };
      for (const id of voted) if (!next[id]) next[id] = 'cast';
      return next;
    });
  }, [queue, me]);
  useEffect(() => {
    if (!me || !contested.length) return;
    const addr = me.addr.toLowerCase();
    const voted = contested.filter(b => b.attestations?.some(a => a.phase === 'challenge' && a.peer_addr?.toLowerCase() === addr)).map(b => b.bindingId);
    if (!voted.length) return;
    setMyChVotes(prev => {
      if (voted.every(id => prev[id])) return prev;
      const next = { ...prev };
      for (const id of voted) if (!next[id]) next[id] = 'cast';
      return next;
    });
  }, [contested, me]);

  // ── Personal review + challenge batches ─────────────────────────────────────
  // `queue` / `contested` arrive in the SHARED order every peer agrees on
  // (review: boost → FIFO → id; challenge: FIFO by challenged_at → id). Each
  // personal queue is that shared pool minus what THIS peer has already resolved
  // — a peer's vote advances only their own cursor; the binding stays in the
  // shared pool (and in other peers' queues) until the network resolves it.
  const personalQueue = useMemo(() => queue.filter(b => !myVotes[b.bindingId]), [queue, myVotes]);
  // Bindings this peer has already voted on that are STILL pending — the instant
  // a vote is signed the binding moves out of the review list into "Open votes"
  // and live-updates here until the network reaches consensus, at which point it
  // leaves `queue` entirely and drops off the dashboard.
  const myOpenVotes = useMemo(() => queue.filter(b => myVotes[b.bindingId]), [queue, myVotes]);
  const byId = useMemo(() => Object.fromEntries(queue.map(b => [b.bindingId, b])), [queue]);
  const challengePersonal = useMemo(() => contested.filter(b => !myChVotes[b.bindingId]), [contested, myChVotes]);
  // Same for challenges: a cast support/defend vote moves the contested binding
  // into "Open votes" until the challenge resolves.
  const myChOpenVotes = useMemo(() => contested.filter(b => myChVotes[b.bindingId]), [contested, myChVotes]);
  const contestedById = useMemo(() => Object.fromEntries(contested.map(b => [b.bindingId, b])), [contested]);

  const [batchIds, setBatchIds] = useState([]);
  const [chBatchIds, setChBatchIds] = useState([]);
  // In-session acknowledgements for batch entries the network resolved before
  // this peer could vote.  The peer can't (and shouldn't) cast a vote anymore,
  // but they must clear the slot explicitly — silently dropping it would let
  // the unified gate advance around items the peer never actually addressed.
  const [batchAcks, setBatchAcks] = useState({});
  const [chBatchAcks, setChBatchAcks] = useState({});
  // Snapshot of each batch entry's last-known data, so a row stays renderable
  // after the binding leaves the live queue (status flipped from `pending` to
  // canon / expelled / lapsed, or from contested to deprecate / reaffirmed).
  const [batchSnapshot, setBatchSnapshot] = useState({});
  const [chBatchSnapshot, setChBatchSnapshot] = useState({});
  useEffect(() => {
    setBatchSnapshot(prev => {
      const next = {};
      for (const id of batchIds) next[id] = byId[id] || prev[id] || null;
      const pk = Object.keys(prev), nk = Object.keys(next);
      if (pk.length === nk.length && nk.every(k => prev[k] === next[k])) return prev;
      return next;
    });
  }, [batchIds, byId]);
  useEffect(() => {
    setChBatchSnapshot(prev => {
      const next = {};
      for (const id of chBatchIds) next[id] = contestedById[id] || prev[id] || null;
      const pk = Object.keys(prev), nk = Object.keys(next);
      if (pk.length === nk.length && nk.every(k => prev[k] === next[k])) return prev;
      return next;
    });
  }, [chBatchIds, contestedById]);

  // Effective batch — live queue data when present, falling back to the snapshot
  // for rows whose binding left the queue (network-resolved) while still
  // committed to this peer's batch.
  const batch = batchIds.map(id => byId[id] || batchSnapshot[id]).filter(Boolean);
  const challengeBatch = chBatchIds.map(id => contestedById[id] || chBatchSnapshot[id]).filter(Boolean);

  // Per-entry status helpers — an entry is "resolved-in-batch" when it has
  // dropped out of the live queue (canon / expelled / lapsed, or deprecate /
  // reaffirmed on the challenge side).  An ack only counts while the binding is
  // resolved: if a lapsed binding gets re-filed and re-enters the batch with
  // a fresh review round, a stale ack from the previous lifecycle is ignored.
  const isResolvedReview = (id) => !byId[id];
  const isResolvedChallenge = (id) => !contestedById[id];
  const isDoneReview = (id) => !!myVotes[id] || (isResolvedReview(id) && !!batchAcks[id]);
  const isDoneChallenge = (id) => !!myChVotes[id] || (isResolvedChallenge(id) && !!chBatchAcks[id]);

  // The batch still "holds" closed slots so the clear-all gate keeps counting
  // them, but they render under Open votes — the live review/challenge lists show
  // only what this peer still has to act on (vote on a pending entry, or
  // acknowledge one the network resolved before they got to vote).
  const reviewBatch = batch.filter(b => !isDoneReview(b.bindingId));
  const challengeReviewBatch = challengeBatch.filter(b => !isDoneChallenge(b.bindingId));
  // Count of resolved-but-unacted batch entries on each surface — totals the
  // peer still owes that the shared `personalQueue` / `challengePersonal` lists
  // can't see (resolved bindings aren't in the live queue anymore).
  const resolvedReviewAckPending    = batchIds.filter(id => isResolvedReview(id) && !isDoneReview(id)).length;
  const resolvedChallengeAckPending = chBatchIds.filter(id => isResolvedChallenge(id) && !isDoneChallenge(id)).length;
  const needsReviewCount    = personalQueue.length      + resolvedReviewAckPending;
  const needsChallengeCount = challengePersonal.length  + resolvedChallengeAckPending;

  // ── Unified clear-all gate ──────────────────────────────────────────────────
  // Each surface is "cleared" when this peer has actively closed every slot in
  // their current batch — voted on the still-pending entries AND acknowledged
  // any entries the network resolved before they got to them.  The next batch
  // in EITHER queue loads only once ALL surfaces are cleared, so a peer can
  // never churn reviews while challenges or taxonomy proposals pile up
  // unaddressed, and the gate never silently advances around a slot the peer
  // never personally closed.
  const reviewBatchCleared    = batchIds.every(id => isDoneReview(id));
  const challengeBatchCleared = chBatchIds.every(id => isDoneChallenge(id));
  const taxCleared            = taxReview.cleared;
  const revCleared            = revGate.cleared;
  const allCleared            = reviewBatchCleared && challengeBatchCleared && taxCleared && revCleared;

  // A batch holds its current ≤3 while the peer still owes ANY action on it
  // (vote on a pending entry, or acknowledge a network-resolved one) OR while
  // any OTHER surface is still outstanding (the gate).  Only when every slot is
  // actively closed does the front of the shared order advance to the next 3.
  useEffect(() => {
    setBatchIds(prev => {
      // Keep every prior entry — even those the network resolved — until the
      // peer acknowledges them.  Defensive: drop only ids we have no data for
      // (neither live in the queue nor in the captured snapshot), which would
      // only happen on a stale state we can't render anyway.
      const valid = prev.filter(id => byId[id] || batchSnapshot[id]);
      const actionable = valid.filter(id => !isDoneReview(id));
      const next = (actionable.length > 0 || !allCleared)
        ? valid
        : personalQueue.slice(0, 3).map(b => b.bindingId);
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) return prev;
      return next;
    });
  }, [personalQueue, byId, batchSnapshot, myVotes, batchAcks, allCleared]);

  useEffect(() => {
    setChBatchIds(prev => {
      const valid = prev.filter(id => contestedById[id] || chBatchSnapshot[id]);
      const actionable = valid.filter(id => !isDoneChallenge(id));
      const next = (actionable.length > 0 || !allCleared)
        ? valid
        : challengePersonal.slice(0, 3).map(b => b.bindingId);
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) return prev;
      return next;
    });
  }, [challengePersonal, contestedById, chBatchSnapshot, myChVotes, chBatchAcks, allCleared]);

  const handleReviewAck = (b) => setBatchAcks(a => a[b.bindingId] ? a : { ...a, [b.bindingId]: true });
  const handleChallengeAck = (b) => setChBatchAcks(a => a[b.bindingId] ? a : { ...a, [b.bindingId]: true });

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
      onConfirm: async (_unusedSig, note) => {
        const topicHash = await slugToBytes32(b.topicId);
        // The authorising signature is now the EIP-712 *Vote*: the on-chain call
        // signs it AND sends the tx (so the user sees a signature prompt then a
        // tx prompt). In dev mode (no contract) signVoteOnly signs the same Vote
        // without a tx so the off-chain attestation still carries a verifiable
        // signature. phase 0 = review.
        let txHash = null, sig = null, noteHash = null, round = null, bindingHash = null;
        if (CONSENSUS_ADDR) {
          ({ txHash, sig, noteHash, round, bindingHash } =
            await castReviewVoteOnChain(b.id, topicHash, verdict === 'approve', note));
          setChainPending('Confirming on-chain…'); await waitForTx(txHash); setChainPending(null);
        } else {
          ({ sig, noteHash, round, bindingHash } =
            await signVoteOnly(b.id, topicHash, 0, verdict === 'approve', note));
        }
        // Once the on-chain vote confirms it is authoritative and irreversible.
        // Record the off-chain signed attestation, but never let its failure
        // (CORS, RPC lag, transient 5xx) strand the vote: mark it cast either
        // way so the binding moves to Open votes and the peer is never prompted
        // to re-vote a binding the chain already accepts. The indexer backfills
        // the attestation from the ReviewVoteCast event if this write is lost.
        try {
          await castReviewVote(b, verdict, me.addr, me.handle, note, sig, txHash, peerCount, { round, noteHash, bindingHash });
          setToast({ type: 'info', msg: 'Vote recorded' });
        } catch (e) {
          if (!txHash) throw e;   // no contract: the off-chain write IS the vote
          console.warn('Off-chain attestation write failed (on-chain vote stands):', e);
          setToast({ type: 'warn', msg: 'Vote cast on-chain — record will sync shortly' });
        }
        setMyVotes(v => ({ ...v, [b.bindingId]: verdict }));
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
      onConfirm: async (_unusedSig, note) => {
        const topicHash = await slugToBytes32(b.topicId);
        // EIP-712 *Vote* signature, phase 1 (challenge). The on-chain call signs
        // then sends; signVoteOnly signs without a tx in dev mode.
        let txHash = null, sig = null, noteHash = null, round = null, bindingHash = null;
        if (CONSENSUS_ADDR) {
          ({ txHash, sig, noteHash, round, bindingHash } =
            await castChallengeVoteOnChain(b.id, topicHash, support, note));
          setChainPending('Confirming on-chain…'); await waitForTx(txHash); setChainPending(null);
        } else {
          ({ sig, noteHash, round, bindingHash } =
            await signVoteOnly(b.id, topicHash, 1, support, note));
        }
        // On-chain vote is authoritative once confirmed — don't let an off-chain
        // attestation write failure strand it (see handleVote). The indexer
        // backfills from the ChallengeVoteCast event if this write is lost.
        try {
          await castChallengeVote(b, support, me.addr, me.handle, note, sig, txHash, peerCount, { round, noteHash, bindingHash });
          setToast({ type: 'info', msg: 'Challenge vote recorded' });
        } catch (e) {
          if (!txHash) throw e;   // no contract: the off-chain write IS the vote
          console.warn('Off-chain challenge attestation write failed (on-chain vote stands):', e);
          setToast({ type: 'warn', msg: 'Vote cast on-chain — record will sync shortly' });
        }
        setMyChVotes(v => ({ ...v, [b.bindingId]: verdict }));
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
  // blocking the unified gate.  Mirrors the gate's "voted-or-acked" definition
  // so a resolved-but-unacknowledged slot keeps the counter > 0.
  const reviewBatchPending    = reviewBatch.length;
  const challengeBatchPending = challengeReviewBatch.length;
  const taxPending            = taxReview.pendingForMe;
  const revPending            = revGate.pendingForMe;
  const gateItems = [
    reviewBatchPending    > 0 && { key: 'review',    tab: 'queue',      text: `${reviewBatchPending} review${reviewBatchPending === 1 ? '' : 's'}` },
    challengeBatchPending > 0 && { key: 'challenge', tab: 'challenges', text: `${challengeBatchPending} challenge${challengeBatchPending === 1 ? '' : 's'}` },
    taxPending            > 0 && { key: 'taxonomy',  tab: 'taxonomy',   text: `${taxPending} taxonomy proposal${taxPending === 1 ? '' : 's'}` },
    revPending            > 0 && { key: 'revocation', tab: 'peers',     text: `${revPending} peer revocation${revPending === 1 ? '' : 's'}` },
  ].filter(Boolean);

  // The surfaces for the always-visible gate strip — `left` is what THIS peer
  // still owes on the current batch (must hit 0 to unlock), `total` the rest of
  // their personal queue waiting behind it.
  const gateSurfaces = [
    { key: 'review',    tab: 'queue',      label: 'Reviews',    left: reviewBatchPending,    total: personalQueue.length },
    { key: 'challenge', tab: 'challenges', label: 'Challenges', left: challengeBatchPending, total: challengePersonal.length },
    { key: 'taxonomy',  tab: 'taxonomy',   label: 'Taxonomy',   left: taxPending,            total: taxPending },
    { key: 'revocation', tab: 'peers',     label: 'Revocations', left: revPending,           total: revPending },
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
              <span className="pill pill--verified" style={{ fontSize: 9 }}><span className="dot" />Verified</span>
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
          <button className={tab === 'queue' ? 'is-active' : ''} onClick={() => setTab('queue')}>Review queue <span style={{ marginLeft: 8, opacity: 0.7 }}>{needsReviewCount}</span></button>
          <button className={tab === 'challenges' ? 'is-active' : ''} onClick={() => setTab('challenges')}>Challenges <span style={{ marginLeft: 8, opacity: 0.7 }}>{needsChallengeCount}</span></button>
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
              <h2 style={{ marginTop: 10 }}><em>{reviewBatch.length}</em> to review now</h2>
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

          <QueueToggle view={queueView} onChange={setQueueView} needsLabel="Needs my review" needsCount={needsReviewCount} openCount={myOpenVotes.length} />

          {queueView === 'needs' ? (
            <>
              {personalQueue.length === 0 && reviewBatch.length === 0 ? (
                <div className="pr-empty">
                  <h3>{queue.length === 0 ? 'The queue is clear' : "You're all caught up"}</h3>
                  <p>{queue.length === 0
                    ? 'No filings are awaiting review yet. Boosted submissions are promoted into review and surface here.'
                    : `You've voted every filing currently in review. ${queue.length} still awaiting other peers to reach consensus.`}</p>
                  {myOpenVotes.length > 0 && (
                    <button type="button" className="btn btn--ghost btn--sm" style={{ marginTop: 14 }} onClick={() => setQueueView('open')}>
                      View your {myOpenVotes.length} open vote{myOpenVotes.length === 1 ? '' : 's'} →
                    </button>
                  )}
                </div>
              ) : (
                <div>
                  <div className="pr-queue-rows">
                    {reviewBatch.map(b => <ReviewRow key={b.bindingId} b={b} mine={false} resolvedInBatch={isResolvedReview(b.bindingId)} onVote={handleVote} onLapse={handleLapse} onAck={handleReviewAck} onPreview={setPreview} onHistory={seeHistory} peerCount={peerCount} />)}
                  </div>
                  {reviewBatchPending > 0
                    ? (() => {
                        // Items in the shared queue parked behind this peer's
                        // current batch — `personalQueue` includes the current
                        // batch's still-pending entries, so subtract them.
                        const waiting = personalQueue.filter(b => !batchIds.includes(b.bindingId)).length;
                        return waiting > 0 && (
                          <p className="small" style={{ color: 'var(--ink-soft)', marginTop: 12 }}>
                            Finish your batch to reveal the next {Math.min(3, waiting)}.
                          </p>
                        );
                      })()
                    : <GateNotice surface="review" />}
                </div>
              )}

              {queued.length > 0 && (
                <div style={{ marginTop: 36 }}>
                  <div className="pr-topic-bar" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="n">Waiting for a review slot · {queued.length} queued (highest public boost first)</span>
                  </div>
                </div>
              )}
            </>
          ) : (
            <OpenVotesView
              items={myOpenVotes}
              empty="Vote on a filing under “Needs my review” and it'll appear here so you can track its status until the network reaches consensus."
              renderRow={(b) => <ReviewRow key={b.bindingId} b={b} mine onVote={handleVote} onLapse={handleLapse} onPreview={setPreview} onHistory={seeHistory} peerCount={peerCount} />}
            />
          )}
        </section>
      )}

      {tab === 'challenges' && (
        <section>
          <div className="pr-tab-head">
            <div>
              <span className="eyebrow">Your challenge batch · support or defend</span>
              <h2 style={{ marginTop: 10 }}><em>{challengeBatchPending}</em> to vote now</h2>
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

          <QueueToggle view={chQueueView} onChange={setChQueueView} needsLabel="Needs my vote" needsCount={needsChallengeCount} openCount={myChOpenVotes.length} />

          {chQueueView === 'needs' ? (
            challengePersonal.length === 0 && challengeReviewBatch.length === 0 ? (
              <div className="pr-empty">
                <h3>{contested.length === 0 ? 'No active challenges' : "You're all caught up"}</h3>
                <p>{contested.length === 0
                  ? 'Canon bindings under contest appear here. Open one from the public archive.'
                  : `You've voted every challenge currently open. ${contested.length} still awaiting other peers to reach consensus.`}</p>
                {myChOpenVotes.length > 0 && (
                  <button type="button" className="btn btn--ghost btn--sm" style={{ marginTop: 14 }} onClick={() => setChQueueView('open')}>
                    View your {myChOpenVotes.length} open vote{myChOpenVotes.length === 1 ? '' : 's'} →
                  </button>
                )}
              </div>
            ) : (
              <div>
                <div className="pr-queue-rows">
                  {challengeReviewBatch.map(b => <ChallengeRow key={b.bindingId} b={b} mine={false} resolvedInBatch={isResolvedChallenge(b.bindingId)} onVote={handleChallengeVote} onFinalize={handleFinalize} onAck={handleChallengeAck} onPreview={setPreview} peerCount={peerCount} />)}
                </div>
                {challengeBatchPending > 0
                  ? (() => {
                      const waiting = challengePersonal.filter(b => !chBatchIds.includes(b.bindingId)).length;
                      return waiting > 0 && (
                        <p className="small" style={{ color: 'var(--ink-soft)', marginTop: 12 }}>
                          Finish your batch to reveal the next {Math.min(3, waiting)}.
                        </p>
                      );
                    })()
                  : <GateNotice surface="challenge" />}
              </div>
            )
          ) : (
            <OpenVotesView
              items={myChOpenVotes}
              empty="Vote on a challenge under “Needs my vote” and it'll appear here so you can track its status until the network reaches consensus."
              renderRow={(b) => <ChallengeRow key={b.bindingId} b={b} mine onVote={handleChallengeVote} onFinalize={handleFinalize} onPreview={setPreview} peerCount={peerCount} />}
            />
          )}
        </section>
      )}

      {tab === 'log' && <LogTab key={logQuery} initialQuery={logQuery} peerCount={peerCount} />}
      {tab === 'taxonomy' && <TaxonomyTab me={me} setToast={setToast} onPropose={() => setShowPropose(true)} review={taxReview} />}
      {tab === 'peers' && <PeersTab me={me} peerCount={peerCount} onNominate={() => setShowNominate(true)} onSeed={() => setShowSeed(true)} reloadSignal={reloadPeers} setToast={setToast} onPeerHistory={seePeerHistory} onRevocationChange={revGate.refetch} />}

      {preview && <EvidencePreviewModal b={preview} onClose={() => setPreview(null)} />}
      {pendingSign && <SignModal payload={pendingSign} onCancel={() => setPendingSign(null)} onSign={(note) => runSigned(pendingSign, note)} />}
      {showPropose && <ProposeModalWrap me={me} onClose={() => setShowPropose(false)} setToast={setToast} />}
      {showNominate && <NominateModal me={me} onClose={() => setShowNominate(false)} onDone={() => { setShowNominate(false); setReloadPeers(n => n + 1); }} setToast={setToast} />}
      {showSeed && <NominateModal seed onClose={() => setShowSeed(false)} onDone={() => { setShowSeed(false); setReloadPeers(n => n + 1); }} setToast={setToast} />}

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
  const [logQuery, setLogQuery] = useState('');
  const seePeerHistory = (addr) => { setLogQuery(addr); setTab('log'); };
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

      {tab === 'log'   && <LogTab key={logQuery} initialQuery={logQuery} />}
      {tab === 'peers' && <PeersTab me={null} peerCount={peerCount} onNominate={() => {}} setToast={setToast} onPeerHistory={seePeerHistory} />}
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
  // ?observe=1 (e.g. the home page's "Open the full vote history" link) lands a
  // guest straight in read-only observer mode, skipping the connect wall. A
  // returning verified peer still falls through to their workspace — observerMode
  // only governs the wallet-less path (see `showConnect` / `verified` below).
  const [observerMode, setObserverMode] = useState(() => {
    try { return new URLSearchParams(window.location.search).has('observe'); } catch { return false; }
  });
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
