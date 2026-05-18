import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { BrandMark } from '../components/Sigil';
import {
  PILLARS,
  canonizeThreshold, expelThreshold, deprecateThreshold,
  PENDING_WINDOW_DAYS, CHALLENGE_WINDOW_DAYS, daysRemaining,
  usePendingEvidence, useContestedEvidence, useCanonEvidence, useAttestationLog,
  useUnchainedPending, useChainEvents, useTamperAlerts, useHeartbeats, useMyReviewCount,
  castReviewVote, openChallenge, castChallengeVote, finalizeChallengeSupabase,
  markEvidenceOnchain,
} from '../evidence-data';
import {
  connectWallet, switchToTargetChain, getActivePeerCount, getPeerHandle, isPeerActive,
  isGenesisPeer, getNomineeThreshold, getRevokeThreshold,
  endorseNominee as endorseNomineeOnChain,
  motionRevoke as motionRevokeOnChain,
  voteRevoke as voteRevokeOnChain,
  castReviewVoteOnChain, castReviewVoteBatchOnChain, castChallengeVoteOnChain,
  openChallengeOnChain, finalizeChallengeOnChain, markLapsedOnChain,
  submitEvidenceOnChain, waitForTx,
  nominatePeer as nominatePeerOnChain,
  hasEndorsedNominee, hasVotedForRevoke,
  hasVotedOnChain, hasVotedManyOnChain, hasVotedForRevokeMany,
  signAttestation, CONSENSUS_ADDR, CONSENSUS_CHAIN_ID,
  getChallengeCooldownRemaining,
  getActivePeersAggregated, getNomineesAggregated,
  isNominationsOpen, getSeedPhaseK,
  computeContentHash,
  prefetchWallet,
  // Behaviour archive (alignment companion) — sibling contract that reads
  // the peer registry from EvidenceConsensus across the contract boundary.
  BEHAVIOUR_CONSENSUS_ADDR, signBehaviourAttestation,
  submitBehaviourOnChain, castBehaviourReviewVoteOnChain,
  openBehaviourChallengeOnChain, castBehaviourChallengeVoteOnChain,
  finalizeBehaviourChallengeOnChain, computeTripleHash,
  computeBehaviourModelHash, computeBehaviourPayloadHash,
  getBehaviourChallengeCooldownRemaining,
  hasVotedOnBehaviour,
} from '../lib/wallet';
import {
  BEHAVIOUR_DOMAINS,
  STATUS_LABEL as BH_STATUS_LABEL,
  useMyBehaviourReviewCount, useBehaviourNeedsReviewCount,
  useCanonBehaviour,
} from '../behaviour-data';
import metamaskFox from '../assets/metamask-fox.svg';
import '../styles/interstellar.css';
import '../styles/peer-review.css';

// ── Helpers ──────────────────────────────────────────────────────────────────
const SHORT = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
const NAME_OF = (p) => p.handle || SHORT(p.addr);

// Mobile browsers don't have a MetaMask extension — instead we hand off to the
// MetaMask mobile app's in-app dApp browser via its universal deep link, which
// re-opens this URL with `window.ethereum` injected.
function isMobile() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}
function metamaskDeepLink() {
  const host = window.location.host + window.location.pathname;
  return `https://metamask.app.link/dapp/${host}`;
}


// ── Jazzicon ─────────────────────────────────────────────────────────────────
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function paletteFor(addr) {
  const h = hashStr(addr);
  const base = h % 360;
  return [base, (base + 80) % 360, (base + 200) % 360, (base + 300) % 360]
    .map(hue => `oklch(0.72 0.14 ${hue})`);
}
function Jazzicon({ addr = '0x0', size = 32, ring = false }) {
  const colors = paletteFor(addr);
  const seed = hashStr(addr);
  const layers = [
    { shape: 'rect', x: 0, y: 0, w: size, h: size, fill: colors[0] },
    { shape: 'circle', cx: ((seed % 100) / 100) * size,         cy: (((seed >> 4) % 100) / 100) * size,  r: size * 0.55, fill: colors[1] },
    { shape: 'circle', cx: (((seed >> 8) % 100) / 100) * size,  cy: (((seed >> 12) % 100) / 100) * size, r: size * 0.38, fill: colors[2] },
    { shape: 'circle', cx: (((seed >> 16) % 100) / 100) * size, cy: (((seed >> 20) % 100) / 100) * size, r: size * 0.22, fill: colors[3] },
  ];
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      style={{ borderRadius: '50%', display: 'block', flexShrink: 0, boxShadow: ring ? '0 0 0 2px var(--bg-elev), 0 0 0 3px var(--accent)' : undefined }}
      aria-hidden="true">
      <defs><clipPath id={`clip-${seed}`}><circle cx={size/2} cy={size/2} r={size/2} /></clipPath></defs>
      <g clipPath={`url(#clip-${seed})`}>
        {layers.map((l, i) => l.shape === 'rect'
          ? <rect key={i} x={l.x} y={l.y} width={l.w} height={l.h} fill={l.fill} />
          : <circle key={i} cx={l.cx} cy={l.cy} r={l.r} fill={l.fill} opacity={0.92} />)}
      </g>
    </svg>
  );
}

function MetaMaskFox({ size = 22 }) {
  return <img src={metamaskFox} width={size} height={size} alt="MetaMask" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }} />;
}

function RefreshButton({ onClick, spinning, label = 'Refresh', title = 'Refresh' }) {
  return (
    <button
      type="button"
      className={`pr-refresh ${spinning ? 'is-spinning' : ''}`}
      onClick={onClick}
      disabled={spinning}
      title={title}
      aria-label={title}
    >
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5" />
        <path d="M4 4v4.5h4.5" />
        <path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.5" />
        <path d="M20 20v-4.5h-4.5" />
      </svg>
      {spinning ? 'Refreshing' : label}
    </button>
  );
}

function NameBadge({ source, small }) {
  if (source !== 'ens') return null;
  return (
    <span className="pr-tag ok" title="Resolved via ENS reverse lookup"
      style={{ marginLeft: 8, transform: 'translateY(-2px)', padding: small ? '3px 7px' : '5px 10px', fontSize: small ? 8 : 9 }}>
      <span className="pr-tag-dot" />ENS
    </span>
  );
}

// ── Nav ───────────────────────────────────────────────────────────────────────
function Nav({ wallet, role, onDisconnect }) {
  const links = [
    { id: 'manifesto',   label: 'Manifesto',   href: '/#manifesto' },
    { id: 'pillars',     label: 'Pillars',     href: '/#pillars' },
    { id: 'book',        label: 'Thesis',      href: '/#book' },
    { id: 'peace',       label: 'Peace',       href: '/#peace' },
    { id: 'evidence',    label: 'Evidence',    href: '/evidence/' },
    { id: 'behaviour',   label: 'Alignment',   href: '/alignment/' },
    { id: 'peer-review', label: 'Peer Review', href: '/peer-review/' },
  ];
  return (
    <nav className="nav">
      <div className="nav-inner">
        <a href="/" className="brand">
          <BrandMark />
          <span className="brand-text">Interstellar Psychology<small>A Multiverse of Love</small></span>
        </a>
        <div className="nav-links">
          {links.map(l => (
            <a key={l.id} href={l.href} className={l.id === 'peer-review' ? 'is-active' : ''}>{l.label}</a>
          ))}
        </div>
        {wallet ? (
          <button className="pr-wallet-pill"
            data-status={role === 'unverified' ? 'unverified' : role === 'pending' ? 'pending' : 'verified'}
            onClick={onDisconnect} title="Disconnect">
            <span className="pr-bullet" />
            <Jazzicon addr={wallet} size={18} />
            <span>{SHORT(wallet)}</span>
          </button>
        ) : (
          <span className="pr-wallet-pill" style={{ opacity: 0.6 }}>
            <span className="pr-bullet" style={{ background: 'var(--ink-faint)', boxShadow: 'none' }} />
            Not connected
          </span>
        )}
      </div>
    </nav>
  );
}

// ── IdentityHeader ────────────────────────────────────────────────────────────
function IdentityHeader({ me, role, pendingCount, reviewCount, bhPendingCount, bhReviewCount }) {
  const tags = [];
  if (role === 'elder') tags.push({ label: 'Genesis peer', cls: 'elder' });
  if (role === 'peer' || role === 'elder') tags.push({ label: 'Verified · can attest', cls: 'ok' });

  return (
    <section className="pr-identity">
      <div className="pr-id-main">
        <div>
          <h2 className="pr-id-handle">{NAME_OF(me)}<NameBadge source={me.nameSource} /></h2>
          <div className="pr-id-addr">{me.addr}</div>
          <div className="pr-id-tags">
            {tags.map((t, i) => (
              <span key={i} className={`pr-tag ${t.cls}`}>
                {t.cls && <span className="pr-tag-dot" />}{t.label}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="pr-id-stats">
        <div className="pr-id-stat"><b>{reviewCount ?? '…'}</b><span>Evidence signed</span></div>
        <div className="pr-id-stat"><b>{pendingCount}</b><span>Evidence pending</span></div>
        <div className="pr-id-stat"><b>{bhReviewCount ?? '…'}</b><span>Alignment signed</span></div>
        <div className="pr-id-stat"><b>{bhPendingCount ?? 0}</b><span>Alignment pending</span></div>
      </div>
    </section>
  );
}

// ── AttestBar — shows approve and reject progress on separate lines ───────────
function AttestBar({ approvals, rejections, canonThresh, expelThresh }) {
  return (
    <div className="pr-attest-split">
      <div className="pr-attest-row">
        <span className="pr-attest-label approve">Approve</span>
        <div className="pr-attest-track">
          <div className="pr-attest-fill approve" style={{ width: `${Math.min(100, (approvals / canonThresh) * 100)}%` }} />
        </div>
        <span className="pr-attest-fraction"><b>{approvals}</b>/{canonThresh}</span>
      </div>
      <div className="pr-attest-row">
        <span className="pr-attest-label reject">Reject</span>
        <div className="pr-attest-track">
          <div className="pr-attest-fill reject" style={{ width: `${Math.min(100, (rejections / expelThresh) * 100)}%` }} />
        </div>
        <span className="pr-attest-fraction"><b>{rejections}</b>/{expelThresh}</span>
      </div>
    </div>
  );
}

// ── ReviewCard — one pending evidence item in the queue ──────────────────────
function ReviewCard({ item, myVerdict, onVote, onLapseChain, meAddr, peerCount }) {
  const canonThresh = canonizeThreshold(item.tier, peerCount);
  const expThresh   = expelThreshold(peerCount);

  const atts        = item.attestations || [];
  const reviewAtts  = atts.filter(a => a.phase === 'review' || !a.phase);
  const approvals   = reviewAtts.filter(a => a.verdict === 'approve').length;
  const rejections  = reviewAtts.filter(a => a.verdict === 'reject').length;

  const tierLabel = item.tier === 1 ? 'TI' : item.tier === 2 ? 'TII' : 'TIII';
  const days      = daysRemaining(item.expires_at || item.submitted_at, PENDING_WINDOW_DAYS);
  const urgent    = days !== null && days <= 5;

  return (
    <article className="pr-review">
      <div>
        <div className="pr-review-eyebrow">
          <span className="pr-review-type">{item.type}</span>
          <span className="pr-review-tier" data-tier={item.tier}>
            <span className="bar"><i /><i /><i /></span>
            {tierLabel}
          </span>
          <span className="pr-review-pillar">Pillar <b>{item.pillarNum}</b> · {item.pillarTitle}</span>
          {days !== null && (
            <span className="pr-review-expiry" data-urgent={urgent}>
              {days === 0 ? 'Expires today' : `${days}d left`}
            </span>
          )}
        </div>

        <h3 className="pr-review-title">{item.title}</h3>
        <p className="pr-review-src">{item.source} · <span className="year">{item.year}</span></p>
        <p className="pr-review-excerpt">{item.excerpt}</p>

        <div className="pr-review-meta">
          {item.submitted_at && <span>Filed <b>{new Date(item.submitted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</b></span>}
          {item.link && <span>· Source <a href={item.link} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-2)' }}>open ↗</a></span>}
        </div>
      </div>

      <aside className="pr-vote-panel">
        <div className="pr-vote-title">Attestations</div>

        <AttestBar approvals={approvals} rejections={rejections} canonThresh={canonThresh} expelThresh={expThresh} />

        {reviewAtts.length > 0 && (
          <div className="pr-attest-peers">
            {reviewAtts.map((a, i) => (
              <div key={i} className="pr-attest-peer" title={a.note || ''}>
                {a.peer_addr && <Jazzicon addr={a.peer_addr} size={14} />}
                <span>{a.peer_handle || SHORT(a.peer_addr)}</span>
                <span className={`verdict ${a.verdict}`}>{a.verdict}</span>
              </div>
            ))}
            {myVerdict && meAddr && (
              <div className="pr-attest-peer" style={{ borderTop: '1px dashed var(--line-soft)', paddingTop: 6 }}>
                <Jazzicon addr={meAddr} size={14} />
                <span>You</span>
                <span className={`verdict ${myVerdict}`}>{myVerdict}</span>
              </div>
            )}
          </div>
        )}

        {days === 0 ? (
          <div className="pr-vote-actions">
            <button className="pr-vote-btn" style={{ opacity: 0.6 }} disabled>Window closed</button>
            {onLapseChain && (
              <button className="pr-vote-btn reject" onClick={() => onLapseChain(item)}>
                Record lapse on-chain
              </button>
            )}
          </div>
        ) : myVerdict ? (
          <div className="pr-vote-cast-note">
            Your attestation is recorded. Votes are final once cast.
          </div>
        ) : (
          <div className="pr-vote-actions">
            <button className="pr-vote-btn approve" onClick={() => onVote(item, 'approve')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12 l4 4 L19 6" /></svg>
              Approve
            </button>
            <button className="pr-vote-btn reject" onClick={() => onVote(item, 'reject')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6 l12 12 M18 6 l-12 12" /></svg>
              Reject
            </button>
          </div>
        )}

        <div className="pr-vote-hint">
          Tier {item.tier === 1 ? 'I' : item.tier === 2 ? 'II' : 'III'} ·
          {' '}{canonThresh} of {peerCount ?? '…'} peers to canonize
          {item.tier === 1 && ' + elder'}
          {' '}· {expThresh} to expel
        </div>
      </aside>
    </article>
  );
}

// ── ChallengeCard — one contested canon item ─────────────────────────────────
function ChallengeCard({ item, myVote, onVote, onFinalize, peerCount, meAddr }) {
  const challengeAtts = (item.attestations || []).filter(a => a.phase === 'challenge');
  const challengers   = challengeAtts.filter(a => a.verdict === 'challenge').length;
  const defenders     = challengeAtts.filter(a => a.verdict === 'defend').length;
  const depThresh     = deprecateThreshold(item.tier, peerCount);
  const days          = daysRemaining(item.challenged_at, CHALLENGE_WINDOW_DAYS);
  const urgent        = days !== null && days <= 3;
  const tierLabel     = item.tier === 1 ? 'TI' : item.tier === 2 ? 'TII' : 'TIII';

  return (
    <article className="pr-review pr-review-challenged">
      <div>
        <div className="pr-review-eyebrow">
          <span className="pr-tag" style={{ color: 'var(--warn)', borderColor: 'color-mix(in oklab, var(--warn) 40%, var(--line))' }}>
            <span className="pr-tag-dot" style={{ background: 'var(--warn)' }} />Contested
          </span>
          <span className="pr-review-type">{item.type}</span>
          <span className="pr-review-tier" data-tier={item.tier}><span className="bar"><i /><i /><i /></span>{tierLabel}</span>
          <span className="pr-review-pillar">Pillar <b>{item.pillarNum}</b> · {item.pillarTitle}</span>
          {days !== null && (
            <span className="pr-review-expiry" data-urgent={urgent}>
              {days === 0 ? 'Window closes today' : `${days}d to resolve`}
            </span>
          )}
        </div>

        <h3 className="pr-review-title">{item.title}</h3>
        <p className="pr-review-src">{item.source} · <span className="year">{item.year}</span></p>

        {item.challenge_reason && (
          <div className="pr-challenge-reason">
            <div className="pr-challenge-reason-label">Challenge grounds</div>
            <p>{item.challenge_reason}</p>
          </div>
        )}
      </div>

      <aside className="pr-vote-panel">
        <div className="pr-vote-title">Challenge vote</div>

        <div className="pr-attest-split">
          <div className="pr-attest-row">
            <span className="pr-attest-label reject">Challenge</span>
            <div className="pr-attest-track">
              <div className="pr-attest-fill reject" style={{ width: `${Math.min(100, (challengers / depThresh) * 100)}%` }} />
            </div>
            <span className="pr-attest-fraction"><b>{challengers}</b>/{depThresh}</span>
          </div>
          <div className="pr-attest-row">
            <span className="pr-attest-label approve">Defend</span>
            <div className="pr-attest-track">
              <div className="pr-attest-fill approve" style={{ width: `${challengers + defenders > 0 ? (defenders / (challengers + defenders)) * 100 : 0}%` }} />
            </div>
            <span className="pr-attest-fraction"><b>{defenders}</b></span>
          </div>
        </div>

        {challengeAtts.length > 0 && (
          <div className="pr-attest-peers">
            {challengeAtts.map((a, i) => (
              <div key={i} className="pr-attest-peer" title={a.note || ''}>
                {a.peer_addr && <Jazzicon addr={a.peer_addr} size={14} />}
                <span>{a.peer_handle || SHORT(a.peer_addr)}</span>
                <span className={`verdict ${a.verdict === 'challenge' ? 'reject' : 'approve'}`}>
                  {a.verdict}
                </span>
              </div>
            ))}
          </div>
        )}

        {days === 0 ? (
          <div className="pr-vote-actions">
            <button className="pr-vote-btn" style={{ opacity: 0.5 }} disabled>Window closed</button>
            {onFinalize && (
              <button className="pr-vote-btn approve" onClick={() => onFinalize(item)}>
                Finalize challenge →
              </button>
            )}
          </div>
        ) : myVote ? (
          <div className="pr-vote-cast-note">
            You voted to <b>{myVote}</b> this challenge. Votes are final.
          </div>
        ) : (
          <div className="pr-vote-actions">
            <button className="pr-vote-btn reject" onClick={() => onVote(item, true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6 l12 12 M18 6 l-12 12" /></svg>
              Challenge
            </button>
            <button className="pr-vote-btn approve" onClick={() => onVote(item, false)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22 C6 18 3 13 3 9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 4-3 9-9 13z" /></svg>
              Defend
            </button>
          </div>
        )}

        <div className="pr-vote-hint">
          {depThresh} challenge votes deprecate this evidence · defense majority reaffirms it
        </div>
      </aside>
    </article>
  );
}

// ── OpenChallengePanel — browse canon evidence and open a new challenge ───────
function OpenChallengePanel({ onOpen, peerCount, cooldownSecs = 0 }) {
  const [search, setSearch]       = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const { canon, loading, hasMore, loadMore, total } = useCanonEvidence(debounced);
  const [selected, setSelected]   = useState(null);
  const [reason, setReason]       = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!selected || reason.trim().length === 0) return;
    setSubmitting(true);
    await onOpen(selected, reason.trim());
    setSelected(null);
    setReason('');
    setSubmitting(false);
  };

  const cooldownDays = cooldownSecs > 0 ? Math.ceil(cooldownSecs / 86400) : 0;
  const cooldownDate = cooldownSecs > 0
    ? new Date(Date.now() + cooldownSecs * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : null;

  return (
    <div className="pr-open-challenge">
      <div className="eyebrow" style={{ marginBottom: 14 }}>◇ Open a new challenge</div>
      {cooldownSecs > 0 ? (
        <p className="pr-open-challenge-sub" style={{ color: 'var(--warn)' }}>
          Challenge cooldown active — you can open your next challenge in {cooldownDays} day{cooldownDays === 1 ? '' : 's'} ({cooldownDate}).
        </p>
      ) : (
      <>
      <p className="pr-open-challenge-sub">
        Select a canon piece of evidence and state your grounds. Other peers will have {CHALLENGE_WINDOW_DAYS} days to vote.
        {' '}{deprecateThreshold(2, peerCount)} votes deprecates it; a defense majority reaffirms it.
      </p>

      <div style={{ margin: '0 0 14px' }}>
        <input
          type="search"
          placeholder="Search canon by title, source, tags…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: '100%', padding: '10px 14px', border: '1px solid var(--line-soft)', borderRadius: 'var(--radius)', background: 'var(--bg-elev)', color: 'var(--ink)', fontFamily: 'var(--mono)', fontSize: 12 }}
        />
      </div>

      {loading && canon.length === 0 ? (
        <div className="pr-open-challenge-empty">Loading canon archive…</div>
      ) : canon.length === 0 ? (
        <div className="pr-open-challenge-empty">
          {debounced ? `No canon evidence matches "${debounced}".` : 'No canon evidence yet. Canonize some submissions first.'}
        </div>
      ) : (
        <>
          <div className="pr-canon-list">
            {canon.map(ev => (
              <button key={ev.id}
                className={`pr-canon-item ${selected?.id === ev.id ? 'is-selected' : ''}`}
                onClick={() => setSelected(selected?.id === ev.id ? null : ev)}>
                <span className="pr-canon-item-tier" data-tier={ev.tier}>T{ev.tier}</span>
                <span className="pr-canon-item-title">{ev.title}</span>
                <span className="pr-canon-item-src">{ev.source}</span>
              </button>
            ))}
          </div>
          {hasMore && (
            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <button className="pr-peer-btn" onClick={loadMore} disabled={loading}>
                {loading ? 'Loading…' : `Load more${total ? ` · ${canon.length} of ${total}` : ''}`}
              </button>
            </div>
          )}
        </>
      )}

      {selected && (
        <div className="pr-challenge-form">
          <div className="pr-challenge-form-label">
            Challenging: <em>{selected.title}</em>
          </div>
          <textarea
            className="pr-challenge-textarea"
            placeholder="State your grounds clearly. What specific claim is wrong, misleading, or unsupported?"
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={4}
          />
          <div className="pr-challenge-form-foot">
            <span className="pr-vote-hint" style={{ flex: 1 }}>
              {reason.trim().length === 0 ? 'Grounds required' : 'Ready to sign'}
            </span>
            <button
              className="pr-nominate-btn"
              disabled={reason.trim().length === 0 || submitting}
              onClick={handleSubmit}>
              {submitting ? 'Signing…' : 'Open challenge →'}
            </button>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}

// ── PeerCard ──────────────────────────────────────────────────────────────────
function PeerCard({ peer, meAddr, myEndorse, myRevokeVote, onEndorse, onRevoke, onRevokeVote, currentRole }) {
  const isMe   = meAddr && peer.addr === meAddr;
  const canAct = currentRole === 'peer' || currentRole === 'elder';

  if (peer.role === 'nominee') {
    const endorsed = peer.endorsedBy + (myEndorse ? 1 : 0);
    const pct = Math.min(100, (endorsed / peer.threshold) * 100);
    return (
      <div className="pr-peer-card is-pending">
        <Jazzicon addr={peer.addr} size={56} />
        <div>
          <h3 className="pr-peer-name">{NAME_OF(peer)}<NameBadge source={peer.nameSource} small /></h3>
          <div className="pr-peer-addr">{SHORT(peer.addr)}</div>
          <div className="pr-peer-meta">
            <div>Bio · <b>{peer.bio}</b></div>
            <div>Nominated by · <b>{peer.nominatedBy}</b></div>
            <div>Filed · <b>{new Date(peer.nominatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</b></div>
          </div>
          <div className="pr-quorum">
            <span>Quorum</span>
            <div className="pr-quorum-bar"><i style={{ width: pct + '%' }} /></div>
            <b>{endorsed}/{peer.threshold}</b>
          </div>
          <div className="pr-peer-actions">
            <button className={`pr-peer-btn approve ${myEndorse ? 'cast' : ''}`}
              onClick={() => canAct && onEndorse(peer.addr)} disabled={!canAct}>
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12 l4 4 L19 6" /></svg>
              {myEndorse ? 'Endorsed' : 'Endorse'}
            </button>
            <button className="pr-peer-btn" disabled={!canAct}>View profile →</button>
          </div>
        </div>
      </div>
    );
  }

  if (peer.role === 'revoking') {
    const votes = peer.revokeVotes + (myRevokeVote ? 1 : 0);
    const pct   = Math.min(100, (votes / peer.revokeThreshold) * 100);
    return (
      <div className="pr-peer-card is-revoking">
        <Jazzicon addr={peer.addr} size={56} />
        <div>
          <h3 className="pr-peer-name" style={{ textDecoration: 'line-through', textDecorationColor: 'var(--danger)' }}>
            {NAME_OF(peer)}
          </h3>
          <div className="pr-peer-addr">{SHORT(peer.addr)}</div>
          <div className="pr-peer-meta">
            <div>Status · <b style={{ color: 'var(--danger)' }}>Revocation in progress</b></div>
            <div>Motion · <b>{peer.motionedBy}</b></div>
            <div>Reason · <b>{peer.revokeReason}</b></div>
          </div>
          <div className="pr-quorum">
            <span>Revocation vote</span>
            <div className="pr-quorum-bar danger"><i style={{ width: pct + '%' }} /></div>
            <b>{votes}/{peer.revokeThreshold}</b>
          </div>
          <div className="pr-peer-actions">
            <button className={`pr-peer-btn danger ${myRevokeVote ? 'cast' : ''}`}
              onClick={() => canAct && onRevokeVote(peer.addr)} disabled={!canAct}>
              <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 6 l12 12 M18 6 l-12 12" /></svg>
              {myRevokeVote ? 'Vote signed' : 'Vote to revoke'}
            </button>
            <button className="pr-peer-btn">Defend →</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pr-peer-card">
      <Jazzicon addr={peer.addr} size={56} />
      <div>
        <h3 className="pr-peer-name">
          {NAME_OF(peer)}<NameBadge source={peer.nameSource} small />
          {isMe && <span className="pr-tag" style={{ marginLeft: 8, transform: 'translateY(-2px)' }}>You</span>}
          {peer.role === 'elder' && <span className="pr-tag elder" style={{ marginLeft: 8, transform: 'translateY(-2px)' }}>Genesis</span>}
        </h3>
        <div className="pr-peer-addr">{SHORT(peer.addr)}</div>
        <div className="pr-peer-meta">
          <div>Bio · <b>{peer.bio}</b></div>
          <div>Reviews · <b>{peer.reviews}</b></div>
          <div>Endorsed by · <b>{peer.endorsedBy}</b></div>
          <div>Joined · <b>{peer.joined}</b></div>
        </div>
        <div className="pr-peer-actions">
          <button className="pr-peer-btn">View attestations</button>
          {!isMe && canAct && (
            <button className="pr-peer-btn danger" onClick={() => onRevoke(peer.addr)}>
              Motion to revoke
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── OpsPanel — operator-visible health surface ───────────────────────────────
// Renders edge-function heartbeats (chain-indexer-evidence, audit-content-hash)
// and any open tamper alerts. Both tables already have public-read RLS, so
// this panel works for any visitor; the data is operationally meaningful but
// non-sensitive. Stale heartbeats and unresolved tamper alerts are visually
// emphasised so an operator can spot a problem at a glance.
// Scope controls which heartbeats and tamper-alerts source the panel queries.
//   'evidence'  → chain-indexer-evidence + audit-content-hash + tamper_alerts
//   'alignment' → chain-indexer-alignment + audit-behaviour-hash + behaviour_tamper_alerts
function OpsPanel({ scope = 'evidence' } = {}) {
  const { rows: allHeartbeats, loading: hbLoading } = useHeartbeats();
  const { alerts, loading: alLoading }              = useTamperAlerts(10, scope);

  // Function names this scope owns. Hides cross-archive entries so the
  // evidence panel doesn't surface alignment-indexer health and vice versa.
  const SCOPE_FUNCTIONS = scope === 'alignment'
    ? ['chain-indexer-alignment', 'audit-behaviour-hash']
    : ['chain-indexer-evidence',  'audit-content-hash'];
  const heartbeats = allHeartbeats.filter(hb => SCOPE_FUNCTIONS.includes(hb.function_name));

  const openAlerts = alerts.filter(a => !a.resolved_at);

  function fmtAge(ts) {
    if (!ts) return '—';
    const ms = Date.now() - new Date(ts).getTime();
    const s  = Math.floor(ms / 1000);
    if (s < 60)        return `${s}s ago`;
    if (s < 3600)      return `${Math.floor(s / 60)}m ago`;
    if (s < 86400)     return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  // Threshold for "stale": 5 min for the indexer (cron runs every minute),
  // 36 h for the audit (daily). Matches the alert thresholds in DEPLOYMENT.md.
  const STALE_THRESHOLD_MS = {
    'chain-indexer-evidence':   5  * 60_000,
    'chain-indexer-alignment':  5  * 60_000,
    'audit-content-hash':      36 * 60 * 60_000,
    'audit-behaviour-hash':    36 * 60 * 60_000,
  };
  function isStale(row) {
    if (!row.last_success) return true;
    const thresh = STALE_THRESHOLD_MS[row.function_name] ?? 5 * 60_000;
    return (Date.now() - new Date(row.last_success).getTime()) > thresh;
  }

  return (
    <section style={{ marginTop: -22, marginBottom: 8 }}>
      <div className="eyebrow" style={{ marginBottom: 12 }}>◇ System health</div>

      {/* Heartbeats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12, marginBottom: 18 }}>
        {hbLoading ? (
          <div style={{ padding: 14, color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em' }}>LOADING HEARTBEATS…</div>
        ) : heartbeats.length === 0 ? (
          <div style={{
            padding: '12px 16px',
            border: '1px dashed color-mix(in oklab, var(--warn) 50%, var(--line))',
            background: 'color-mix(in oklab, var(--warn) 8%, var(--bg-elev))',
            borderRadius: 'var(--radius)',
            fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em',
            color: 'var(--ink-soft)',
          }}>
            No heartbeats recorded yet — the indexer + audit jobs have never
            reported. Check pg_cron + vault secrets.
          </div>
        ) : (
          heartbeats.map(hb => {
            const stale = isStale(hb);
            return (
              <div key={hb.function_name} style={{
                padding: '12px 16px',
                border: `1px solid ${stale ? 'var(--danger)' : 'var(--line-soft)'}`,
                background: stale
                  ? 'color-mix(in oklab, var(--danger) 8%, var(--bg-elev))'
                  : 'var(--bg-elev)',
                borderRadius: 'var(--radius)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: stale ? 'var(--danger)' : hb.last_status === 'ok' ? 'var(--ok)' : 'var(--warn)',
                  }} />
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink)' }}>
                    {hb.function_name}
                  </span>
                  <span style={{
                    marginLeft: 'auto',
                    fontFamily: 'var(--mono)', fontSize: 13,
                    fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase',
                    color: stale ? 'var(--danger)' : hb.last_status === 'ok' ? 'var(--ok)' : hb.last_status ? 'var(--warn)' : 'var(--ink-faint)',
                  }}>
                    {hb.last_status || '—'}
                  </span>
                </div>
                <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-faint)', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px' }}>
                  <span>last ok</span>     <b style={{ color: stale ? 'var(--danger)' : 'var(--ink-soft)', fontWeight: 500 }}>{fmtAge(hb.last_success)}</b>
                  <span>last attempt</span><b style={{ color: 'var(--ink-soft)', fontWeight: 500 }}>{fmtAge(hb.last_attempt)}</b>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Tamper alerts */}
      {!alLoading && openAlerts.length > 0 && (
        <div style={{
          padding: '14px 18px',
          border: '1px solid var(--danger)',
          background: 'color-mix(in oklab, var(--danger) 12%, var(--bg-elev))',
          borderRadius: 'var(--radius-l)',
          marginBottom: 14,
        }}>
          <div className="eyebrow" style={{ marginBottom: 8, color: 'var(--danger)' }}>
            ⚠ {openAlerts.length} unresolved tamper alert{openAlerts.length === 1 ? '' : 's'}
          </div>
          <p className="sub" style={{ margin: '0 0 10px' }}>
            Stored <code>content_hash</code> diverged from the canonical hash for these rows.
            Either the off-chain payload was edited (legitimately or otherwise) or the
            content-hash binding never matched. Investigate before accepting new votes
            against affected evidence.
          </p>
          <div style={{ display: 'grid', gap: 6 }}>
            {openAlerts.map(a => (
              <div key={a.id} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 12, fontFamily: 'var(--mono)', fontSize: 11, alignItems: 'center' }}>
                <span style={{ color: 'var(--ink-faint)' }}>{fmtAge(a.detected_at)}</span>
                <span style={{ color: 'var(--ink)' }}>
                  {(a.evidence?.title || a.behaviour?.title) || a.evidence_id || a.behaviour_id}
                </span>
                <span style={{ color: 'var(--ink-faint)', fontSize: 10 }}>
                  <span title={`expected ${a.expected_hash}`}>exp {a.expected_hash?.slice(0, 10)}…</span>
                  {' '}<span title={`stored ${a.stored_hash}`}>stored {a.stored_hash?.slice(0, 10)}…</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {!alLoading && openAlerts.length === 0 && heartbeats.length > 0 && (
        <p className="sub" style={{ margin: 0, color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em' }}>
          ✓ No open tamper alerts. Content hashes match canonical for every canonized row.
        </p>
      )}
    </section>
  );
}

// ── EvidencePeekModal — light read-only popup used from the chain log ────────
// Fetches a single evidence row by id and renders just enough to identify the
// source. For full detail (challenge flow, etc.) the modal also links to the
// Evidence archive deep-link `/evidence/#ev-<uuid>`.
function EvidencePeekModal({ evidenceId, onClose }) {
  const [data, setData]   = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!evidenceId) return;
    setData(null);
    setError(null);
    let cancelled = false;
    supabase.from('evidence').select('*').eq('id', evidenceId).maybeSingle()
      .then(({ data: row, error: err }) => {
        if (cancelled) return;
        if (err)        setError(err.message);
        else if (!row)  setError('Evidence not found — the id may belong to a row that has since been removed.');
        else            setData(row);
      });
    return () => { cancelled = true; };
  }, [evidenceId]);

  useEffect(() => {
    if (!evidenceId) return;
    const onKey = (ev) => { if (ev.key === 'Escape') onClose(); };
    const prev  = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [evidenceId, onClose]);

  if (!evidenceId) return null;

  const tierLabel = data?.tier === 1 ? 'I' : data?.tier === 2 ? 'II' : data?.tier === 3 ? 'III' : '';
  const pillar    = data ? PILLARS.find(p => p.id === data.pillar_id) : null;

  return (
    <div className="pr-ev-modal-backdrop" onClick={onClose}>
      <div className="pr-ev-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="pr-ev-modal-close" onClick={onClose} aria-label="Close">×</button>
        {error ? (
          <>
            <div className="eyebrow" style={{ marginBottom: 10 }}>◇ Evidence</div>
            <p className="lead" style={{ margin: 0 }}>{error}</p>
            <p className="sub" style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-faint)' }}>{evidenceId}</p>
          </>
        ) : !data ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em' }}>LOADING EVIDENCE…</div>
        ) : (
          <>
            <div className="eyebrow" style={{ marginBottom: 10 }}>
              {data.type}{tierLabel ? ` · Tier ${tierLabel}` : ''}
              {pillar ? ` · Pillar ${pillar.n} · ${pillar.title}` : ''}
            </div>
            <h3 className="pr-ev-modal-title">{data.title}</h3>
            <p className="pr-ev-modal-src">
              <span className="pr-ev-modal-label">Author</span> {data.source}{data.year ? ` · ${data.year}` : ''}
            </p>
            <p className="pr-ev-modal-id" title={`Evidence id · ${data.id}`}>
              <span className="pr-ev-modal-label">ID</span>
              <span className="pr-ev-modal-id-value">{data.id}</span>
            </p>
            {data.excerpt && <p className="pr-ev-modal-body">{data.excerpt}</p>}
            {data.quote && <p className="pr-ev-modal-quote">&ldquo;{data.quote}&rdquo;</p>}
            <div className="pr-ev-modal-actions">
              {data.link && data.link !== '#' && (
                <a href={data.link} target="_blank" rel="noopener noreferrer" className="pr-peer-btn">
                  Open source ↗
                </a>
              )}
              <a href={`/evidence/#ev-${data.id}`} className="pr-peer-btn">
                Open in archive →
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── ChainEventLog — indexed events from the EvidenceConsensus contract ───────
const CHAIN_EVENT_FILTERS = [
  { id: 'submission', label: 'Submissions', cls: 'nominate', names: ['EvidenceSubmitted'] },
  { id: 'vote',       label: 'Votes',       cls: 'endorse',  names: ['ReviewVoteCast', 'ChallengeVoteCast'] },
  { id: 'outcome',    label: 'Outcomes',    cls: 'approve',  names: ['EvidenceCanonized', 'EvidenceExpelled', 'EvidenceLapsed', 'EvidenceDeprecated', 'EvidenceReaffirmed'] },
  { id: 'challenge',  label: 'Challenges',  cls: 'revoke',   names: ['ChallengeOpened'] },
  { id: 'peer',       label: 'Peers',       cls: '',         names: ['PeerAdded', 'PeerRemoved', 'PeerNominated', 'PeerEndorsed', 'NomineeVerified'] },
  { id: 'revocation', label: 'Revocations', cls: 'reject',   names: ['RevocationMotioned', 'RevocationVoteCast', 'PeerRevoked'] },
];

function ChainEventLog({ me, role }) {
  const [query, setQuery]         = useState('');
  const [debounced, setDebounced] = useState('');
  const [groupId, setGroupId]     = useState('');
  const [peekId, setPeekId]       = useState(null);
  const [peerRegistry, setPeerRegistry] = useState([]); // [{ addr, handle }]
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  // On-chain peer registry is the authoritative source for handle→address.
  // Loaded once; used both to resolve handle searches and to label rows.
  const refetchPeerRegistry = useCallback(() => {
    return getActivePeersAggregated()
      .then(list => {
        setPeerRegistry((list || []).map(p => ({ addr: (p.addr || '').toLowerCase(), handle: p.handle || '' })));
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    let cancelled = false;
    getActivePeersAggregated()
      .then(list => {
        if (cancelled) return;
        setPeerRegistry((list || []).map(p => ({ addr: (p.addr || '').toLowerCase(), handle: p.handle || '' })));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const genesisAddr = role === 'elder' && me?.addr ? me.addr.toLowerCase() : null;

  const handleAddrs = useMemo(() => {
    const s = debounced.toLowerCase();
    if (!s) return [];
    const matches = new Set();
    for (const p of peerRegistry) {
      if (p.handle && p.handle.toLowerCase().includes(s)) matches.add(p.addr);
    }
    // "Genesis" is a role label, not a stored handle — once the user has typed
    // at least 3 characters of "genesis", surface the known genesis peer
    // (currently the connected user when role === 'elder').
    if (genesisAddr && s.length >= 3 && 'genesis'.startsWith(s)) matches.add(genesisAddr);
    return [...matches];
  }, [debounced, peerRegistry, genesisAddr]);

  const handleByAddr = useMemo(() => {
    const m = new Map();
    for (const p of peerRegistry) if (p.addr) m.set(p.addr, p.handle);
    return m;
  }, [peerRegistry]);

  const activeGroup = CHAIN_EVENT_FILTERS.find(f => f.id === groupId);
  const eventNames  = activeGroup ? activeGroup.names : [];

  const { events, loading, hasMore, loadMore, total, refetch } = useChainEvents(30, debounced, eventNames, handleAddrs);
  const filtering = debounced.length > 0 || groupId.length > 0;

  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    const minSpin = new Promise(r => setTimeout(r, 600));
    try { await Promise.all([refetch(), refetchPeerRegistry(), minSpin]); }
    finally { setRefreshing(false); }
  }, [refreshing, refetch, refetchPeerRegistry]);

  const controls = (
    <div className="pr-log-controls">
      <div className="pr-log-filters" role="group" aria-label="Filter by event type">
        <button
          type="button"
          className={`pr-log-filter${groupId === '' ? ' is-active' : ''}`}
          onClick={() => setGroupId('')}
        >
          All
        </button>
        {CHAIN_EVENT_FILTERS.map(f => (
          <button
            key={f.id}
            type="button"
            className={`pr-log-filter ${f.cls}${groupId === f.id ? ' is-active' : ''}`}
            onClick={() => setGroupId(prev => prev === f.id ? '' : f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="pr-log-search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by handle, 0x address, or full evidence id…"
          aria-label="Search chain log"
          spellCheck={false}
          autoCapitalize="off"
        />
        <RefreshButton onClick={handleRefresh} spinning={refreshing} title="Refresh chain log" />
      </div>
    </div>
  );

  if (loading && events.length === 0) return (
    <>
      {controls}
      <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em' }}>LOADING CHAIN LOG…</div>
    </>
  );
  if (events.length === 0) return (
    <>
      {controls}
      <div style={{ padding: '60px 20px', textAlign: 'center', border: '1px dashed var(--line-soft)', borderRadius: 'var(--radius-l)' }}>
        <p className="lead" style={{ margin: 0 }}>
          {filtering ? 'No chain events match the current filter.' : "No indexed events yet. The chain-indexer-evidence hasn't run, or the contract has had no activity."}
        </p>
      </div>
    </>
  );
  return (
    <>
      {controls}
      <div className="pr-log">
        {events.map(ev => {
          const when = ev.occurred_at ? new Date(ev.occurred_at) : null;
          const diffH = when ? Math.floor((Date.now() - when.getTime()) / 3_600_000) : null;
          const timeStr = !when ? `block ${ev.block_number}` : diffH < 1 ? 'Just now' : diffH < 24 ? `${diffH}h ago` : `${Math.floor(diffH / 24)}d ago`;
          const explorerBase = CONSENSUS_CHAIN_ID === 56 ? 'https://bscscan.com' : 'https://testnet.bscscan.com';
          return (
            <div key={ev.id} className="pr-log-row">
              <div className="pr-log-time">{timeStr}</div>
              <div className="pr-log-event" style={{ wordBreak: 'break-all' }}>
                <span className="pr-log-kind approve">{ev.event_name}</span>
                {ev.peer_addr && (() => {
                  const h = handleByAddr.get(ev.peer_addr.toLowerCase());
                  return <> <b>{h ? `${h} (${SHORT(ev.peer_addr)})` : ev.peer_addr}</b></>;
                })()}
                {ev.evidence_id && (
                  <> · <button
                    type="button"
                    onClick={() => setPeekId(ev.evidence_id)}
                    className="pr-log-evidence-link"
                    title={`Open evidence · ${ev.evidence_id}`}
                  >
                    {ev.evidence?.title || SHORT(ev.evidence_id)}
                  </button></>
                )}
              </div>
              <div className="pr-log-hash">
                {ev.tx_hash && (
                  <a
                    href={`${explorerBase}/tx/${ev.tx_hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={ev.tx_hash}
                  >
                    {SHORT(ev.tx_hash)} ↗
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {hasMore && (
        <div style={{ marginTop: 12, textAlign: 'center' }}>
          <button className="pr-peer-btn" onClick={loadMore} disabled={loading}>
            {loading ? 'Loading…' : `Load 30 more${total ? ` · ${events.length} of ${total}` : ''}`}
          </button>
        </div>
      )}
      <EvidencePeekModal evidenceId={peekId} onClose={() => setPeekId(null)} />
    </>
  );
}

// ── ActivityLog — live from Supabase attestations ─────────────────────────────
const VERDICT_FILTERS = [
  { value: 'approve',   label: 'Approved',   cls: 'approve' },
  { value: 'reject',    label: 'Rejected',   cls: 'reject' },
  { value: 'challenge', label: 'Challenged', cls: 'revoke' },
  { value: 'defend',    label: 'Defended',   cls: 'endorse' },
];

function ActivityLog() {
  const [query, setQuery]         = useState('');
  const [debounced, setDebounced] = useState('');
  const [verdict, setVerdict]     = useState('');
  const [peekId, setPeekId]       = useState(null);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  const { log, loading, hasMore, loadMore, total, refetch } = useAttestationLog(30, debounced, verdict);
  const filtering = debounced.length > 0 || verdict.length > 0;

  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    const minSpin = new Promise(r => setTimeout(r, 600));
    try { await Promise.all([refetch(), minSpin]); }
    finally { setRefreshing(false); }
  }, [refreshing, refetch]);

  const controls = (
    <div className="pr-log-controls">
      <div className="pr-log-filters" role="group" aria-label="Filter by verdict">
        <button
          type="button"
          className={`pr-log-filter${verdict === '' ? ' is-active' : ''}`}
          onClick={() => setVerdict('')}
        >
          All
        </button>
        {VERDICT_FILTERS.map(f => (
          <button
            key={f.value}
            type="button"
            className={`pr-log-filter ${f.cls}${verdict === f.value ? ' is-active' : ''}`}
            onClick={() => setVerdict(prev => prev === f.value ? '' : f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="pr-log-search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by handle, 0x address, or evidence…"
          aria-label="Search attestation log"
          spellCheck={false}
          autoCapitalize="off"
        />
        <RefreshButton onClick={handleRefresh} spinning={refreshing} title="Refresh attestation log" />
      </div>
    </div>
  );

  if (loading && log.length === 0) return (
    <>
      {controls}
      <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em' }}>LOADING LOG…</div>
    </>
  );
  if (log.length === 0) return (
    <>
      {controls}
      <div style={{ padding: '60px 20px', textAlign: 'center', border: '1px dashed var(--line-soft)', borderRadius: 'var(--radius-l)' }}>
        <p className="lead" style={{ margin: 0 }}>
          {filtering ? 'No attestations match the current filter.' : 'No attestations yet. Be the first to sign.'}
        </p>
      </div>
    </>
  );

  return (
    <>
      {controls}
      <div className="pr-log">
        {log.map((a, i) => {
          const kindMap = { approve: 'approve', reject: 'reject', challenge: 'revoke', defend: 'endorse' };
          const didMap  = { approve: 'approved', reject: 'rejected', challenge: 'challenged', defend: 'defended' };
          const when = new Date(a.created_at);
          const diffH = Math.floor((Date.now() - when.getTime()) / 3_600_000);
          const timeStr = diffH < 1 ? 'Just now' : diffH < 24 ? `${diffH}h ago` : `${Math.floor(diffH / 24)}d ago`;
          const explorerBase = CONSENSUS_CHAIN_ID === 56 ? 'https://bscscan.com' : 'https://testnet.bscscan.com';
          return (
            <div key={i} className="pr-log-row">
              <div className="pr-log-time">{timeStr}</div>
              <div className="pr-log-event">
                <span className={`pr-log-kind ${kindMap[a.verdict] || 'endorse'}`}>{a.verdict}</span>{' '}
                <b>{a.peer_handle || SHORT(a.peer_addr)}</b>{' '}
                <em>{didMap[a.verdict] || a.verdict}</em>{' '}
                {a.evidence_id ? (
                  <button
                    type="button"
                    onClick={() => setPeekId(a.evidence_id)}
                    className="pr-log-evidence-link"
                    title={`Open evidence ${a.evidence_id}`}
                  >
                    {a.evidence_title || SHORT(a.evidence_id)}
                  </button>
                ) : (
                  <span>{a.evidence_title}</span>
                )}
                {a.note && a.note.trim() && (
                  <div style={{ fontStyle: 'italic', fontSize: 12, opacity: 0.8, marginTop: 6, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                    "{a.note}"
                  </div>
                )}
              </div>
              <div className="pr-log-hash">
                {a.tx_hash ? (
                  <a
                    href={`${explorerBase}/tx/${a.tx_hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={a.tx_hash}
                  >
                    {SHORT(a.tx_hash)} ↗
                  </a>
                ) : (
                  <span style={{ color: 'var(--ink-faint)' }}>{SHORT(a.id)}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {hasMore && (
        <div style={{ marginTop: 12, textAlign: 'center' }}>
          <button className="pr-peer-btn" onClick={loadMore} disabled={loading}>
            {loading ? 'Loading…' : `Load 30 more${total ? ` · ${log.length} of ${total}` : ''}`}
          </button>
        </div>
      )}
      <EvidencePeekModal evidenceId={peekId} onClose={() => setPeekId(null)} />
    </>
  );
}

// ── SignModal ─────────────────────────────────────────────────────────────────
// Actions that require a wallet signature.  Other actions (endorse, motion,
// finalize, mark_lapsed) are confirmed on-chain only and do not produce a
// Supabase attestation, so no off-chain signature is collected.
const SIG_REQUIRED_ACTIONS = new Set([
  'attest_evidence', 'challenge_evidence', 'defend_evidence', 'open_challenge',
  'attest_behaviour',
]);

function SignModal({ open, payload, onCancel, onSign, danger, signerAddr }) {
  // Editable deliberation note. Initialised from the payload (callers may
  // pre-fill, e.g. open_challenge passes the grounds), then the peer can edit
  // before signing. The edited value flows into the EIP-712 message AND into
  // the cache row, AND for behaviour-side openChallenge it becomes the grounds
  // emitted on-chain — single source of truth.
  const [note, setNote] = useState('');
  useEffect(() => { setNote(payload?.note ?? ''); }, [payload]);

  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onCancel(); };
    if (open) window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onCancel]);

  if (!open) return null;
  const requiresSig = SIG_REQUIRED_ACTIONS.has(payload?.action);
  const isOpenChallenge = payload?.action === 'open_challenge'
    || (payload?.action === 'attest_behaviour' && payload?.phase === 'challenge' && payload?.verdict === 'challenge');
  const subjectKey = payload?.action === 'attest_behaviour' ? 'behaviourId' : 'evidenceId';
  // Show the actual EIP-712 payload that MetaMask will sign — not a fake.
  const previewPayload = requiresSig
    ? {
        [subjectKey]: payload?.subject || '',
        peerAddr:     signerAddr || '',
        phase:        payload?.phase   || (isOpenChallenge ? 'challenge' : 'review'),
        verdict:      payload?.verdict || '',
        note,
      }
    : { action: payload?.action || '', subject: payload?.subject || '', signer: signerAddr || '' };

  return (
    <div className="pr-modal-backdrop is-open" onClick={onCancel}>
      <div className="pr-modal" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'center' }}>
          <span style={{ color: 'var(--accent)' }}><MetaMaskFox /></span>
          <span className="eyebrow">
            {requiresSig ? 'Sign + send transaction' : 'Send transaction'}
          </span>
        </div>
        <h3>{payload?.title || 'Confirm attestation'}</h3>
        <p>{payload?.sub || 'This action is recorded on-chain and cannot be retracted.'}</p>
        {requiresSig && (
          <div style={{ margin: '10px 0 14px' }}>
            <label style={{ display: 'block', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', opacity: 0.75, marginBottom: 6, fontFamily: 'var(--mono)' }}>
              {isOpenChallenge ? 'Grounds (also recorded on-chain)' : 'Deliberation note (optional but recommended)'}
            </label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={isOpenChallenge ? 5 : 4}
              placeholder={isOpenChallenge
                ? 'State the grounds for the challenge — what is wrong about the verdict, the domain choice, or the binding to the model?'
                : 'Why are you voting this way? The note is signed into your EIP-712 attestation and stored alongside the on-chain count. Empty notes are accepted but produce a thinner deliberation log.'}
              style={{
                width: '100%', padding: '10px 12px',
                border: '1px solid var(--line-soft)', borderRadius: 'var(--radius, 6px)',
                background: 'var(--bg-elev)', color: 'var(--ink)',
                fontFamily: 'var(--serif)', fontSize: 13, lineHeight: 1.5,
                resize: 'vertical',
              }}
            />
          </div>
        )}
        <div className="pr-sign-payload">{JSON.stringify(previewPayload, null, 2)}</div>
        <div className="pr-modal-actions">
          <button className="pr-modal-btn" onClick={onCancel}>Cancel</button>
          <button
            className={`pr-modal-btn ${danger ? 'danger' : 'primary'}`}
            onClick={() => onSign(note)}
            disabled={isOpenChallenge && note.trim().length === 0}
            title={isOpenChallenge && note.trim().length === 0 ? 'Grounds required for a challenge' : undefined}
          >
            {requiresSig ? 'Sign →' : 'Confirm →'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── NotAPeerScreen — observer view for wallets not on the peer registry ──────
// Unverified wallets can't attest, but the consensus record is public — they
// can still inspect the attestation log and the indexed chain log.
function NotAPeerScreen({ addr, onDisconnect }) {
  const [recordType, setRecordType] = useState('evidence');
  const [tab,        setTab]        = useState('log');
  const me = { addr, handle: null, nameSource: 'none' };

  return (
    <main className="pr-wrap">
      <section className="pr-identity pr-identity-observer">
        <div className="pr-id-main">
          <div>
            <h2 className="pr-id-handle pr-id-handle-addr">{addr}</h2>
            <div className="pr-id-tags">
              <span className="pr-tag danger">
                <span className="pr-tag-dot" />Observer · Read-only
              </span>
              <span className="pr-tag">Not on registry</span>
            </div>
          </div>
        </div>
        <div className="pr-observer-actions">
          <button className="pr-peer-btn" onClick={onDisconnect}>
            Disconnect →
          </button>
        </div>
      </section>

      <section className="pr-observer-aside">
        <div className="pr-observer-aside-head">
          <div>
            <div className="eyebrow" style={{ marginBottom: 8 }}>◇ How to become a peer</div>
            <p className="sub" style={{ margin: 0 }}>
              The review and challenge actions are restricted to peers on the{' '}
              <a
                className="pr-mm-meta-link"
                href={`${CONSENSUS_CHAIN_ID === 56 ? 'https://bscscan.com' : 'https://testnet.bscscan.com'}/address/${CONSENSUS_ADDR}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <code style={{ fontFamily: 'var(--mono)', fontSize: '0.85em' }}>EvidenceConsensus</code>
              </a>{' '}
              contract. The record itself is public — you can audit every signed attestation and on-chain event below.
            </p>
          </div>
        </div>
        <div className="pr-observer-steps">
          {[
            ['01', 'Get nominated', 'An existing peer files a nomination with your wallet address.'],
            ['02', 'Receive endorsements', 'Active peers endorse the nomination. Quorum scales with the network, capped at 9.'],
            ['03', 'Access granted', 'Once quorum is reached your address is added to the registry and you can attest.'],
          ].map(([n, title, desc]) => (
            <div key={n} className="pr-observer-step">
              <span className="pr-connect-num">{n}</span>
              <div><b>{title}</b><p>{desc}</p></div>
            </div>
          ))}
        </div>
      </section>

      {/* Top-level archive toggle (matches VerifiedPanel). Read-only on this
          observer screen — no Peer registry tab since unverified addresses
          can't act on it; the "How to become a peer" section above covers
          the registry path. */}
      <div className="pr-tabs" style={{ marginBottom: 8, borderBottom: '1px solid var(--line-soft)' }}>
        <button
          className={`pr-tab ${recordType === 'evidence' ? 'is-active' : ''}`}
          onClick={() => setRecordType('evidence')}
        >
          Evidence
        </button>
        <button
          className={`pr-tab ${recordType === 'alignment' ? 'is-active' : ''}`}
          onClick={() => setRecordType('alignment')}
        >
          Alignment
        </button>
      </div>

      <div className="pr-tabs">
        <button className={`pr-tab ${tab === 'log' ? 'is-active' : ''}`} onClick={() => setTab('log')}>
          Attestation log
        </button>
        <button className={`pr-tab ${tab === 'chain' ? 'is-active' : ''}`} onClick={() => setTab('chain')}>
          Chain log
        </button>
      </div>

      {recordType === 'evidence' && tab === 'log' && (
        <section>
          <div className="pr-section-head">
            <div>
              <h2>Evidence attestation log</h2>
              <p className="sub">
                Every signed action — approvals, rejections, challenges, defenses. The public, append-only
                record of who said what and when.
              </p>
            </div>
          </div>
          <ActivityLog />
        </section>
      )}

      {recordType === 'evidence' && tab === 'chain' && (
        <section>
          <div className="pr-section-head">
            <div>
              <h2>Evidence chain log</h2>
              <p className="sub">
                Indexed events from the EvidenceConsensus contract. The chain is the receipt; this is the receipt.
              </p>
            </div>
          </div>
          <OpsPanel scope="evidence" />
          <ChainEventLog me={me} role="unverified" />
        </section>
      )}

      {recordType === 'alignment' && tab === 'log' && (
        <section>
          <div className="pr-section-head">
            <div>
              <h2>Alignment attestation log</h2>
              <p className="sub">
                Every signed verdict on an AI behaviour record. EIP-712 signatures verifiable against the peer's
                address; tx hashes link to BscScan.
              </p>
            </div>
          </div>
          <BehaviourAttestationLog />
        </section>
      )}

      {recordType === 'alignment' && tab === 'chain' && (
        <section>
          <div className="pr-section-head">
            <div>
              <h2>Alignment chain log</h2>
              <p className="sub">
                Raw events emitted by the BehaviourConsensus contract, indexed every minute. Every state
                transition appears here.
              </p>
            </div>
          </div>
          <OpsPanel scope="alignment" />
          <BehaviourChainEventLog />
        </section>
      )}

      <footer className="pr-footnote">
        <div>
          <b>The record is public</b>
          Even without attestation rights, anyone can audit every signed vote and every on-chain event. Consensus is verifiable, not asserted.
        </div>
        <div>
          <b>Truth can evolve</b>
          Canon evidence can be challenged. A supermajority deprecates it — the history of revision stays visible.
        </div>
        <div>
          <b>The chain is the receipt</b>
          Attestations are append-only. They cannot be edited or hidden. The blockchain figures itself out.
        </div>
      </footer>
    </main>
  );
}

// ── ConnectScreen ─────────────────────────────────────────────────────────────
// Moscovium (Mc, Z=115) electron shells: 2, 8, 18, 32, 32, 18, 5 — 115 electrons total.
// Shells are ordered innermost (n=1) → outermost (n=7); future peers join the valence shell.
const MC_SHELLS = [
  { count: 2,  duration: 10, orbitTop: '36%', dotSize: 4, color: 'var(--accent)'   }, // n=1
  { count: 8,  duration: 16, orbitTop: '30%', dotSize: 4, color: 'var(--accent-2)' }, // n=2
  { count: 18, duration: 22, orbitTop: '24%', dotSize: 5, color: 'var(--accent)'   }, // n=3
  { count: 32, duration: 30, orbitTop: '18%', dotSize: 5, color: 'var(--accent-2)' }, // n=4
  { count: 32, duration: 38, orbitTop: '12%', dotSize: 5, color: 'var(--accent)'   }, // n=5
  { count: 18, duration: 46, orbitTop: '6%',  dotSize: 6, color: 'var(--accent-2)' }, // n=6
  { count: 5,  duration: 54, orbitTop: '0%',  dotSize: 7, color: 'var(--accent)'   }, // n=7 (valence)
];

// Moscovium-290 nucleus: 115 protons + 175 neutrons, phyllotaxis-packed into the core.
const MC_NUCLEONS = (() => {
  const total = 290, protons = 115;
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: total }, (_, i) => {
    const radius = Math.sqrt(i / (total - 1)) * 46; // % of core, leaves a rim
    const angle  = i * GOLDEN_ANGLE;
    // Bresenham-style spread so exactly 115 of the 290 nucleons are protons
    const isProton =
      Math.floor((i + 1) * protons / total) !== Math.floor(i * protons / total);
    return {
      x: 50 + Math.cos(angle) * radius,
      y: 50 + Math.sin(angle) * radius,
      isProton,
    };
  });
})();

function ConnectScreen({ onConnect, connecting, peerCount, nomineeCount, attestationCount }) {
  const verifiedPeers = []; // Jazzicon orbit — reserved for future on-chain peer fetch
  const electronSize  = Math.max(14, 44 - verifiedPeers.length * 2);
  const ORBIT_DUR     = 50;
  // On mobile with no injected provider, route the CTA through MetaMask's
  // universal deep link so the app re-opens this page in its in-app browser.
  const mobileNoProvider = typeof window !== 'undefined' && isMobile() && !window.ethereum;

  return (
    <main className="pr-connect">
      <div className="pr-connect-grid">
        <div>
          <div className="eyebrow">◇ Peer review panel ◇ Wallet-gated</div>
          <h1 className="display" style={{ marginTop: 24 }}>
            Sign in to <em>attest</em><br />the record.
          </h1>
          <p className="lead">
            Evidence is only as strong as the peers who stand behind it. Connect your wallet to
            review submissions, challenge canon, and put your signature on the truth —
            one attestation at a time.
          </p>
          <div className="pr-connect-card">
            <div style={{ display: 'flex', marginBottom: 8, gap: 12, alignItems: 'center' }}>
              <span className="eyebrow">How it works</span>
              <span style={{ flex: 1 }} />
              <a href="/artefacts/blockchain/superalignment.pdf" target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 9, color: 'var(--accent-2)', letterSpacing: '0.18em', textDecoration: 'none', textTransform: 'uppercase' }}>Whitepaper ↗</a>
            </div>
            {[
              ['01', 'Connect your wallet', 'We never read your balance. The signature only proves you control the address.'],
              ['02', 'Attest pending evidence', 'Approve or reject each submission. Quorum canonizes or expels it.'],
              ['03', 'Challenge the canon', 'Already-approved evidence can be contested. A supermajority deprecates it.'],
            ].map(([n, title, desc]) => (
              <div key={n} className="pr-connect-row">
                <span className="pr-connect-num">{n}</span>
                <div><b>{title}</b><p>{desc}</p></div>
              </div>
            ))}
            {mobileNoProvider ? (
              <a className="pr-mm-btn" href={metamaskDeepLink()} style={{ textDecoration: 'none' }}>
                <MetaMaskFox />
                Open in MetaMask app
              </a>
            ) : (
              <button className="pr-mm-btn" onClick={onConnect} disabled={connecting}>
                <MetaMaskFox />
                {connecting ? 'Awaiting signature…' : 'Connect with MetaMask'}
              </button>
            )}
            <div className="pr-mm-meta">
              <div className="pr-mm-meta-row">
                <span className="pr-mm-meta-k">Network</span>
                <span className="pr-mm-meta-v">
                  {CONSENSUS_CHAIN_ID === 56 ? 'BNB Smart Chain' : 'BNB Smart Chain Testnet'} · Chain {CONSENSUS_CHAIN_ID}
                </span>
              </div>
              <div className="pr-mm-meta-row">
                <span className="pr-mm-meta-k">Evidence contract</span>
                {CONSENSUS_ADDR ? (
                  <a
                    className="pr-mm-meta-link"
                    href={`${CONSENSUS_CHAIN_ID === 56 ? 'https://bscscan.com' : 'https://testnet.bscscan.com'}/address/${CONSENSUS_ADDR}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={CONSENSUS_ADDR}
                  >
                    {CONSENSUS_ADDR.slice(0, 8)}…{CONSENSUS_ADDR.slice(-6)} ↗
                  </a>
                ) : (
                  <span className="pr-mm-meta-v">unset</span>
                )}
              </div>
              <div className="pr-mm-meta-row">
                <span className="pr-mm-meta-k">Alignment contract</span>
                {BEHAVIOUR_CONSENSUS_ADDR ? (
                  <a
                    className="pr-mm-meta-link"
                    href={`${CONSENSUS_CHAIN_ID === 56 ? 'https://bscscan.com' : 'https://testnet.bscscan.com'}/address/${BEHAVIOUR_CONSENSUS_ADDR}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={BEHAVIOUR_CONSENSUS_ADDR}
                  >
                    {BEHAVIOUR_CONSENSUS_ADDR.slice(0, 8)}…{BEHAVIOUR_CONSENSUS_ADDR.slice(-6)} ↗
                  </a>
                ) : (
                  <span className="pr-mm-meta-v">unset</span>
                )}
              </div>
            </div>
          </div>
        </div>
        <div>
          <div className="pr-connect-orbit">
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <div key={`ring-${n}`} className={`pr-orbit-ring r${n}`} />
            ))}

            {/* Moscovium (Z=115): seven electron shells, 2·8·18·32·32·18·5 */}
            {MC_SHELLS.flatMap((shell, si) =>
              Array.from({ length: shell.count }, (_, i) => {
                const startDeg = (360 / shell.count) * i;
                const delay    = -(startDeg / 360) * shell.duration;
                return (
                  <div key={`s${si}-${i}`} className="pr-orbit-arm"
                    style={{ '--duration': `${shell.duration}s`, animationDelay: `${delay}s` }}>
                    <div className="pr-orbit-electron" style={{
                      '--duration': `${shell.duration}s`, '--orbit-top': shell.orbitTop,
                      '--dot-color': shell.color, animationDelay: `${delay}s`,
                      width: shell.dotSize, height: shell.dotSize,
                    }}>
                      <div className="pr-orbit-electron-dot" />
                    </div>
                  </div>
                );
              })
            )}

            {/* valence shell: verified peers as Jazzicons */}
            {verifiedPeers.map((p, i) => {
              const startDeg = (360 / verifiedPeers.length) * i;
              const delay    = -(startDeg / 360) * ORBIT_DUR;
              return (
                <div key={p.addr} className="pr-orbit-arm"
                  style={{ '--duration': `${ORBIT_DUR}s`, animationDelay: `${delay}s` }}>
                  <div className="pr-orbit-electron" style={{
                    '--duration': `${ORBIT_DUR}s`, '--orbit-top': '0%',
                    animationDelay: `${delay}s`, width: electronSize, height: electronSize,
                  }}>
                    <Jazzicon addr={p.addr} size={electronSize} />
                  </div>
                </div>
              );
            })}

            <div className="pr-orbit-node nucleus" aria-label="Moscovium-290 nucleus">
              {MC_NUCLEONS.map((n, i) => (
                <div
                  key={`nuc-${i}`}
                  className={`pr-nucleon ${n.isProton ? 'proton' : 'neutron'}`}
                  style={{ left: `${n.x}%`, top: `${n.y}%` }}
                />
              ))}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14, marginTop: 28, maxWidth: 460, marginLeft: 'auto', marginRight: 'auto', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--ink-faint)', textAlign: 'center' }}>
            <div><b style={{ fontFamily: 'var(--serif)', fontSize: 28, color: 'var(--ink)', display: 'block', fontWeight: 300 }}>{peerCount ?? '…'}</b>Verified peers</div>
            <div><b style={{ fontFamily: 'var(--serif)', fontSize: 28, color: 'var(--ink)', display: 'block', fontWeight: 300 }}>{nomineeCount ?? '…'}</b>In nomination</div>
            <div><b style={{ fontFamily: 'var(--serif)', fontSize: 28, color: 'var(--ink)', display: 'block', fontWeight: 300 }}>{attestationCount ?? '…'}</b>Attestations signed</div>
          </div>
        </div>
      </div>
    </main>
  );
}

// ── PeerRegistryTab ───────────────────────────────────────────────────────────
function PeerRegistryTab({ me, nomineeThreshold, revokeThreshold, onEndorse, onMotionRevoke, onVoteRevoke, nominationsOpen, seedPhaseK, peerCount }) {
  const [nominee, setNominee]       = useState('');
  const [nomHandle, setNomHandle]   = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [nominees, setNominees]     = useState([]);
  const [nomLoading, setNomLoading] = useState(false);
  const [peers, setPeers]           = useState([]);
  const [peersLoading, setPeersLoading] = useState(false);
  const [nomSearch, setNomSearch]   = useState('');
  const [peerSearch, setPeerSearch] = useState('');

  const threshold = nomineeThreshold ?? 1;
  const revThresh = revokeThreshold ?? 1;
  const nomLocked = nominationsOpen === false;

  const isValid = nominee.trim().startsWith('0x') && nominee.trim().length === 42;

  const matchesPeer = (q) => {
    const s = q.trim().toLowerCase();
    if (!s) return () => true;
    return (p) => (p.handle || '').toLowerCase().includes(s) || (p.addr || '').toLowerCase().includes(s);
  };
  const filteredNominees = useMemo(() => nominees.filter(matchesPeer(nomSearch)),  [nominees, nomSearch]);
  const filteredPeers    = useMemo(() => peers.filter(matchesPeer(peerSearch)),    [peers,    peerSearch]);

  // Single eth_call to fetch every nominee + endorsement count.  For each
  // pending nominee, follow up with one extra read to detect whether the
  // current user has already endorsed (so we can disable the button locally
  // instead of triggering a guaranteed-revert tx).
  const loadNominees = useCallback(async () => {
    if (!CONSENSUS_ADDR) return;
    setNomLoading(true);
    try {
      const list = await getNomineesAggregated();
      const enriched = me?.addr
        ? await Promise.all(list.map(async (n) => ({
            ...n,
            iEndorsed: await hasEndorsedNominee(n.addr, me.addr),
          })))
        : list.map(n => ({ ...n, iEndorsed: false }));
      setNominees(enriched);
    } catch {
      // RPC unavailable — keep whatever local state exists
    } finally {
      setNomLoading(false);
    }
  }, [me?.addr]);

  // Single eth_call returns every active peer with handle + revocation state.
  // For peers under active revocation, a single Multicall3 batches the
  // "has the connected peer voted for this revocation yet?" lookups; previously
  // this was one RPC per revoking peer.
  const loadPeers = useCallback(async () => {
    if (!CONSENSUS_ADDR || !me?.addr) return;
    setPeersLoading(true);
    try {
      const list = await getActivePeersAggregated();
      const meLower = me.addr.toLowerCase();
      const revokingAddrs = list.filter(p => p.revActive).map(p => p.addr);
      const voteMap = revokingAddrs.length
        ? await hasVotedForRevokeMany(revokingAddrs, me.addr)
        : new Map();
      const enriched = list.map(p => ({
        ...p,
        isMe:   p.addr === meLower,
        iVoted: p.revActive ? !!voteMap.get(p.addr.toLowerCase()) : false,
      }));
      setPeers(enriched);
    } catch {
      // RPC unavailable; keep last good list
    } finally {
      setPeersLoading(false);
    }
  }, [me?.addr]);

  useEffect(() => { loadNominees(); }, [loadNominees]);
  useEffect(() => { loadPeers(); },     [loadPeers]);

  const handleNominate = async () => {
    if (!isValid || nomLocked) return;
    setSubmitting(true);
    try {
      if (CONSENSUS_ADDR) {
        const txHash = await nominatePeerOnChain(nominee.trim(), nomHandle.trim());
        await waitForTx(txHash);
        await loadNominees();
      } else {
        setNominees(prev => [...prev, {
          addr:         nominee.trim(),
          handle:       nomHandle.trim(),
          nominatedBy:  me?.handle || SHORT(me?.addr) || 'you',
          nominatedAt:  new Date().toISOString(),
          endorsements: 0,
        }]);
      }
    } catch {
      // User rejected or tx failed — don't update list
    } finally {
      setNominee('');
      setNomHandle('');
      setSubmitting(false);
    }
  };

  return (
    <section>
      <div className="pr-section-head">
        <div>
          <h2>The peer registry</h2>
          <p className="sub">
            Verified peers may attest to evidence, endorse nominees, and motion revocations.
            New peers need{' '}
            <b style={{ color: 'var(--ink-soft)' }}>{threshold}</b>{' '}
            endorsement{threshold === 1 ? '' : 's'} (scales with network size, capped at 9).
            Revocations need a simple majority ({revokeThreshold ?? 1} vote{(revokeThreshold ?? 1) === 1 ? '' : 's'} now).
          </p>
        </div>
      </div>

      {nomLocked && (
        <div style={{
          marginBottom: 18,
          padding: '14px 18px',
          border: '1px dashed color-mix(in oklab, var(--warn) 50%, var(--line))',
          background: 'color-mix(in oklab, var(--warn) 8%, var(--bg-elev))',
          borderRadius: 'var(--radius-l)',
        }}>
          <div className="eyebrow" style={{ marginBottom: 6 }}>◇ Seed phase active</div>
          <p className="sub" style={{ margin: 0 }}>
            Public nominations unlock once <b>{seedPhaseK ?? '…'}</b> peers are
            on the registry ({peerCount ?? '…'} active today).
            Until then the contract owner seeds peers directly via
            {' '}<code style={{ fontFamily: 'var(--mono)' }}>addPeer</code>.
            This closes the Sybil window where a Genesis-only network could
            otherwise self-promote.
          </p>
        </div>
      )}

      <div className="pr-nominate">
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="eyebrow" style={{ marginBottom: 0 }}>◇ Nominate a new peer</div>
          <input
            placeholder="0x… wallet address (42 characters)"
            value={nominee}
            onChange={e => setNominee(e.target.value)}
            style={{ width: '100%' }}
            disabled={nomLocked}
          />
          <input
            placeholder="Display handle (optional)"
            value={nomHandle}
            onChange={e => setNomHandle(e.target.value)}
            style={{ width: '100%' }}
            disabled={nomLocked}
          />
        </div>
        <button
          className="pr-nominate-btn"
          disabled={!isValid || submitting || nomLocked}
          onClick={handleNominate}
          style={{ alignSelf: 'flex-end' }}
          title={nomLocked ? 'Locked during seed phase' : ''}
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M12 5 v14 M5 12 h14" />
          </svg>
          {submitting ? 'Confirming…' : nomLocked ? 'Locked' : 'File nomination'}
        </button>
      </div>

      {nomLoading ? (
        <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em', marginTop: 28 }}>LOADING NOMINEES…</div>
      ) : (
        <>
          <div className="pr-log-search" style={{ marginTop: 28, marginBottom: 14 }}>
            <input
              type="search"
              value={nomSearch}
              onChange={(e) => setNomSearch(e.target.value)}
              placeholder="Search nominees by handle or 0x address…"
              aria-label="Search nominees"
              spellCheck={false}
              autoCapitalize="off"
            />
          </div>
          {nominees.length === 0 ? (
            <div style={{ padding: '60px 20px', textAlign: 'center', border: '1px dashed var(--line-soft)', borderRadius: 'var(--radius-l)' }}>
              <p className="lead" style={{ margin: 0 }}>No nominees yet. Be the first to nominate a peer.</p>
            </div>
          ) : filteredNominees.length === 0 ? (
            <div style={{ padding: '40px 20px', textAlign: 'center', border: '1px dashed var(--line-soft)', borderRadius: 'var(--radius-l)' }}>
              <p className="lead" style={{ margin: 0 }}>No nominees match the search.</p>
            </div>
          ) : (
        <div className="pr-peer-list">
          {filteredNominees.map((n, i) => {
            const pct = Math.min(100, ((n.endorsements ?? 0) / threshold) * 100);
            return (
              <div key={n.addr || i} className="pr-peer-card is-pending">
                <div style={{ flex: 1 }}>
                  <h3 className="pr-peer-name">{n.handle || SHORT(n.addr)}</h3>
                  <div className="pr-peer-addr">{n.addr}</div>
                  <div className="pr-quorum" style={{ marginTop: 12 }}>
                    <span>Endorsements</span>
                    <div className="pr-quorum-bar"><i style={{ width: pct + '%' }} /></div>
                    <b>{n.endorsements ?? 0}/{threshold}</b>
                  </div>
                  {onEndorse && (
                    <div className="pr-peer-actions" style={{ marginTop: 12 }}>
                      <button
                        className={`pr-peer-btn approve ${n.iEndorsed ? 'cast' : ''}`}
                        onClick={() => !n.iEndorsed && onEndorse(n)}
                        disabled={n.iEndorsed}
                        title={n.iEndorsed ? 'You have already endorsed this nominee' : 'Endorse this nomination'}
                      >
                        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12 l4 4 L19 6" /></svg>
                        {n.iEndorsed ? 'Endorsed' : 'Endorse'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
          )}
        </>
      )}

      {/* Verified peers + revocation surface */}
      <section style={{ marginTop: 56 }}>
        <div className="eyebrow" style={{ marginBottom: 14 }}>
          ◇ Verified peers · {peers.length}
        </div>
        {peersLoading ? (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em' }}>
            LOADING PEERS…
          </div>
        ) : (
          <>
            <div className="pr-log-search" style={{ marginBottom: 14 }}>
              <input
                type="search"
                value={peerSearch}
                onChange={(e) => setPeerSearch(e.target.value)}
                placeholder="Search peers by handle or 0x address…"
                aria-label="Search verified peers"
                spellCheck={false}
                autoCapitalize="off"
              />
            </div>
            {peers.length === 0 ? (
              <div style={{ padding: '40px 20px', textAlign: 'center', border: '1px dashed var(--line-soft)', borderRadius: 'var(--radius-l)' }}>
                <p className="lead" style={{ margin: 0 }}>No peers loaded. Is the contract reachable?</p>
              </div>
            ) : filteredPeers.length === 0 ? (
              <div style={{ padding: '40px 20px', textAlign: 'center', border: '1px dashed var(--line-soft)', borderRadius: 'var(--radius-l)' }}>
                <p className="lead" style={{ margin: 0 }}>No peers match the search.</p>
              </div>
            ) : (
          <div className="pr-peer-list">
            {filteredPeers.map(p => {
              const pct = p.revActive ? Math.min(100, (p.revVotes / revThresh) * 100) : 0;
              return (
                <div key={p.addr} className={`pr-peer-card ${p.revActive ? 'is-revoking' : ''}`}>
                  <div style={{ flex: 1 }}>
                    <h3 className="pr-peer-name" style={p.revActive ? { textDecoration: 'line-through', textDecorationColor: 'var(--danger)' } : undefined}>
                      {p.handle || SHORT(p.addr)}
                      {p.isMe && <span className="pr-tag" style={{ marginLeft: 8, transform: 'translateY(-2px)' }}>You</span>}
                    </h3>
                    <div className="pr-peer-addr">{p.addr}</div>

                    {p.revActive ? (
                      <>
                        <div className="pr-quorum" style={{ marginTop: 12 }}>
                          <span>Revocation vote</span>
                          <div className="pr-quorum-bar danger"><i style={{ width: pct + '%' }} /></div>
                          <b>{p.revVotes}/{revThresh}</b>
                        </div>
                        <div className="pr-peer-actions" style={{ marginTop: 12 }}>
                          <button
                            className={`pr-peer-btn danger ${p.iVoted ? 'cast' : ''}`}
                            disabled={p.isMe || p.iVoted}
                            onClick={() => !p.iVoted && onVoteRevoke && onVoteRevoke(p.addr)}
                            title={p.isMe ? "You can't vote on your own revocation" : p.iVoted ? 'Already voted' : 'Vote to revoke'}
                          >
                            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 6 l12 12 M18 6 l-12 12" /></svg>
                            {p.iVoted ? 'Vote signed' : 'Vote to revoke'}
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="pr-peer-actions" style={{ marginTop: 12 }}>
                        {!p.isMe && onMotionRevoke && (
                          <button
                            className="pr-peer-btn danger"
                            onClick={() => onMotionRevoke(p.addr)}
                            title="Motion to revoke this peer"
                          >
                            Motion to revoke
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
            )}
          </>
        )}
      </section>
    </section>
  );
}

// ── VerifiedPanel — the main workspace for verified peers ────────────────────
// ── Behaviour panel (alignment archive) ─────────────────────────────────────
//
// Self-contained section rendered inside VerifiedPanel when the record-type
// toggle is switched to 'behaviour'. Reads from the behaviour table, signs
// behaviour-domain EIP-712 attestations, dispatches to BehaviourConsensus.
// Reuses the same peer registry — peers are who they are via EvidenceConsensus,
// so the verified-peer gate above is the same.

function useBehaviourQueue() {
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('behaviour')
      .select('*')
      .eq('submitted_onchain', true)
      .in('status', ['pending'])
      .order('submitted_at', { ascending: false });
    setItems(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { refetch(); }, [refetch]);
  return { items, loading, refetch };
}

function useBehaviourContested() {
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    const { data } = await supabase
      .from('behaviour')
      .select('*')
      .eq('status', 'contested')
      .order('challenged_at', { ascending: false });
    setItems(data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { refetch(); }, [refetch]);
  return { items, loading, refetch };
}

function useUnchainedBehaviour() {
  const [items, setItems] = useState([]);
  const refetch = useCallback(async () => {
    const { data } = await supabase
      .from('behaviour')
      .select('*')
      .eq('status', 'pending')
      .eq('submitted_onchain', false)
      .order('submitted_at', { ascending: false });
    setItems(data ?? []);
  }, []);
  useEffect(() => { refetch(); }, [refetch]);
  return { items, refetch };
}

// ── Behaviour attestation log ───────────────────────────────────────────────
// Parallel to the evidence ActivityLog. Reads from behaviour_attestations,
// joined with behaviour title for context. Each row is a signed peer verdict.

function useBehaviourAttestationLog({ filter = 'all', limit = 50 } = {}) {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    let q = supabase
      .from('behaviour_attestations')
      .select('id, behaviour_id, peer_addr, peer_handle, phase, verdict, note, tx_hash, eip712_sig, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (filter === 'review' || filter === 'challenge') q = q.eq('phase', filter);
    const { data } = await q;

    // Fetch behaviour titles for context (one extra query, denormalised in JS).
    const ids = Array.from(new Set((data ?? []).map(r => r.behaviour_id)));
    let titles = {};
    if (ids.length) {
      const { data: bh } = await supabase
        .from('behaviour')
        .select('id, title, domain, tier')
        .in('id', ids);
      titles = Object.fromEntries((bh ?? []).map(b => [b.id, b]));
    }
    setRows((data ?? []).map(r => ({ ...r, behaviour: titles[r.behaviour_id] || null })));
    setLoading(false);
  }, [filter, limit]);

  useEffect(() => { refetch(); }, [refetch]);
  return { rows, loading, refetch };
}

function BehaviourAttestationLog() {
  // Mirrors the evidence ActivityLog control shape: debounced search +
  // verdict filter chips + refresh, all inside .pr-log-controls.
  const [query, setQuery]         = useState('');
  const [debounced, setDebounced] = useState('');
  const [verdict, setVerdict]     = useState('');
  const [peekId, setPeekId]       = useState(null);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim().toLowerCase()), 250);
    return () => clearTimeout(id);
  }, [query]);

  const { rows, loading, refetch } = useBehaviourAttestationLog({ filter: 'all', limit: 200 });
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    const minSpin = new Promise(r => setTimeout(r, 600));
    try { await Promise.all([refetch(), minSpin]); }
    finally { setRefreshing(false); }
  }, [refreshing, refetch]);

  // Client-side filter — the hook fetches the last 200 rows; query and verdict
  // refine that locally so the UI feels instant.
  const filtered = useMemo(() => rows.filter(r => {
    if (verdict && r.verdict !== verdict) return false;
    if (!debounced) return true;
    const hay = [
      r.behaviour?.title, r.peer_handle, r.peer_addr, r.note, r.behaviour_id,
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(debounced);
  }), [rows, debounced, verdict]);

  const filtering = debounced.length > 0 || verdict.length > 0;

  const controls = (
    <div className="pr-log-controls">
      <div className="pr-log-filters" role="group" aria-label="Filter by verdict">
        <button
          type="button"
          className={`pr-log-filter${verdict === '' ? ' is-active' : ''}`}
          onClick={() => setVerdict('')}
        >
          All
        </button>
        {VERDICT_FILTERS.map(f => (
          <button
            key={f.value}
            type="button"
            className={`pr-log-filter ${f.cls}${verdict === f.value ? ' is-active' : ''}`}
            onClick={() => setVerdict(prev => prev === f.value ? '' : f.value)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="pr-log-search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by handle, 0x address, or alignment case…"
          aria-label="Search alignment attestation log"
          spellCheck={false}
          autoCapitalize="off"
        />
        <RefreshButton onClick={handleRefresh} spinning={refreshing} title="Refresh attestation log" />
      </div>
    </div>
  );

  if (loading && rows.length === 0) return (
    <>
      {controls}
      <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em' }}>LOADING LOG…</div>
    </>
  );
  if (filtered.length === 0) return (
    <>
      {controls}
      <div style={{ padding: '60px 20px', textAlign: 'center', border: '1px dashed var(--line-soft)', borderRadius: 'var(--radius-l)' }}>
        <p className="lead" style={{ margin: 0 }}>
          {filtering ? 'No attestations match the current filter.' : 'No alignment attestations yet.'}
        </p>
      </div>
    </>
  );

  return (
    <>
      {controls}
      <div className="pr-log">
        {filtered.map((r, i) => {
          const kindMap = { approve: 'approve', reject: 'reject', challenge: 'revoke', defend: 'endorse' };
          const didMap  = { approve: 'aligned', reject: 'misaligned', challenge: 'challenged', defend: 'defended' };
          const when    = new Date(r.created_at);
          const diffH   = Math.floor((Date.now() - when.getTime()) / 3_600_000);
          const timeStr = diffH < 1 ? 'Just now' : diffH < 24 ? `${diffH}h ago` : `${Math.floor(diffH / 24)}d ago`;
          const explorerBase = CONSENSUS_CHAIN_ID === 56 ? 'https://bscscan.com' : 'https://testnet.bscscan.com';
          return (
            <div key={i} className="pr-log-row">
              <div className="pr-log-time">{timeStr}</div>
              <div className="pr-log-event">
                <span className={`pr-log-kind ${kindMap[r.verdict] || 'endorse'}`}>{r.verdict}</span>{' '}
                <b>{r.peer_handle || SHORT(r.peer_addr)}</b>{' '}
                <em>{didMap[r.verdict] || r.verdict}</em>{' '}
                {r.behaviour_id ? (
                  <button
                    type="button"
                    onClick={() => setPeekId(r.behaviour_id)}
                    className="pr-log-evidence-link"
                    title={`Open alignment case · ${r.behaviour_id}`}
                  >
                    {r.behaviour?.title || SHORT(r.behaviour_id)}
                  </button>
                ) : (
                  <span>{r.behaviour?.title}</span>
                )}
                {r.note && r.note.trim() && (
                  <div style={{ fontStyle: 'italic', fontSize: 12, opacity: 0.8, marginTop: 6, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                    "{r.note}"
                  </div>
                )}
              </div>
              <div className="pr-log-hash">
                {r.tx_hash ? (
                  <a
                    href={`${explorerBase}/tx/${r.tx_hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={r.tx_hash}
                  >
                    {SHORT(r.tx_hash)} ↗
                  </a>
                ) : (
                  <span style={{ color: 'var(--ink-faint)' }}>{SHORT(r.id)}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <BehaviourPeekModal behaviourId={peekId} onClose={() => setPeekId(null)} />
    </>
  );
}

// ── Behaviour chain event log ───────────────────────────────────────────────
// Parallel to the evidence ChainEventLog. Reads from behaviour_chain_events
// (filled by chain-indexer-alignment). One row per emitted event.

function useBehaviourChainEvents({ filter = 'all', limit = 100 } = {}) {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    setLoading(true);
    let q = supabase
      .from('behaviour_chain_events')
      .select('id, block_number, tx_hash, log_index, event_name, behaviour_id, peer_addr, payload, occurred_at')
      .order('block_number', { ascending: false })
      .order('log_index',    { ascending: false })
      .limit(limit);
    if (filter !== 'all') q = q.eq('event_name', filter);
    const { data } = await q;

    // Denormalise titles by behaviour_id, same pattern as the attestation log
    // hook. One extra query per refetch is cheap; we get the human-readable
    // case name into the row so the chain log doesn't render bare 0x ids.
    const ids = Array.from(new Set((data ?? []).map(r => r.behaviour_id).filter(Boolean)));
    let titles = {};
    if (ids.length) {
      const { data: bh } = await supabase
        .from('behaviour')
        .select('id, title, domain, tier, status')
        .in('id', ids);
      titles = Object.fromEntries((bh ?? []).map(b => [b.id, b]));
    }

    // Denormalise peer handles too — chain events don't carry the handle in
    // their payload (the contract emits address only). Look it up first in
    // behaviour_attestations, then fall back to evidence attestations. The
    // peer registry is shared across the two archives so the handle is the
    // same either way; we just take the first hit.
    const peerAddrs = Array.from(new Set((data ?? []).map(r => r.peer_addr).filter(Boolean)));
    const handles = {};
    if (peerAddrs.length) {
      const { data: bhAtt } = await supabase
        .from('behaviour_attestations')
        .select('peer_addr, peer_handle')
        .in('peer_addr', peerAddrs)
        .not('peer_handle', 'is', null);
      for (const row of (bhAtt ?? [])) {
        if (!handles[row.peer_addr] && row.peer_handle) handles[row.peer_addr] = row.peer_handle;
      }
      const missing = peerAddrs.filter(a => !handles[a]);
      if (missing.length) {
        const { data: evAtt } = await supabase
          .from('attestations')
          .select('peer_addr, peer_handle')
          .in('peer_addr', missing)
          .not('peer_handle', 'is', null);
        for (const row of (evAtt ?? [])) {
          if (!handles[row.peer_addr] && row.peer_handle) handles[row.peer_addr] = row.peer_handle;
        }
      }
    }

    setRows((data ?? []).map(r => ({
      ...r,
      behaviour:   titles[r.behaviour_id] || null,
      peer_handle: handles[r.peer_addr] || null,
    })));
    setLoading(false);
  }, [filter, limit]);

  useEffect(() => { refetch(); }, [refetch]);
  return { rows, loading, refetch };
}

// Behaviour-side event-type groups (mirrors CHAIN_EVENT_FILTERS for evidence).
const BEHAVIOUR_CHAIN_EVENT_FILTERS = [
  { id: 'submission', label: 'Submissions', cls: 'nominate', names: ['BehaviourSubmitted'] },
  { id: 'vote',       label: 'Votes',       cls: 'endorse',  names: ['ReviewVoteCast', 'ChallengeVoteCast'] },
  { id: 'outcome',    label: 'Outcomes',    cls: 'approve',  names: ['BehaviourAligned', 'BehaviourMisaligned', 'BehaviourLapsed', 'BehaviourDeprecated', 'BehaviourReaffirmed'] },
  { id: 'challenge',  label: 'Challenges',  cls: 'revoke',   names: ['ChallengeOpened'] },
];

function BehaviourChainEventLog() {
  // Mirrors the evidence ChainEventLog control shape exactly: debounced search
  // + event-group filter chips + refresh, all inside .pr-log-controls.
  const [query, setQuery]         = useState('');
  const [debounced, setDebounced] = useState('');
  const [groupId, setGroupId]     = useState('');
  const [peekId, setPeekId]       = useState(null);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim().toLowerCase()), 250);
    return () => clearTimeout(id);
  }, [query]);

  const { rows, loading, refetch } = useBehaviourChainEvents({ filter: 'all', limit: 300 });
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    const minSpin = new Promise(r => setTimeout(r, 600));
    try { await Promise.all([refetch(), minSpin]); }
    finally { setRefreshing(false); }
  }, [refreshing, refetch]);

  const activeGroup = BEHAVIOUR_CHAIN_EVENT_FILTERS.find(f => f.id === groupId);
  const eventNames  = activeGroup ? activeGroup.names : null;

  // Client-side filter — last 300 rows fetched once, refined locally on every
  // keystroke / chip click.
  const filtered = useMemo(() => rows.filter(r => {
    if (eventNames && !eventNames.includes(r.event_name)) return false;
    if (!debounced) return true;
    const hay = [
      r.peer_addr, r.event_name, r.behaviour_id, r.behaviour?.title,
      r.payload?.grounds, JSON.stringify(r.payload),
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(debounced);
  }), [rows, debounced, eventNames]);

  const filtering = debounced.length > 0 || groupId.length > 0;

  const controls = (
    <div className="pr-log-controls">
      <div className="pr-log-filters" role="group" aria-label="Filter by event type">
        <button
          type="button"
          className={`pr-log-filter${groupId === '' ? ' is-active' : ''}`}
          onClick={() => setGroupId('')}
        >
          All
        </button>
        {BEHAVIOUR_CHAIN_EVENT_FILTERS.map(f => (
          <button
            key={f.id}
            type="button"
            className={`pr-log-filter ${f.cls}${groupId === f.id ? ' is-active' : ''}`}
            onClick={() => setGroupId(prev => prev === f.id ? '' : f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="pr-log-search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by handle, 0x address, or full behaviour id…"
          aria-label="Search alignment chain log"
          spellCheck={false}
          autoCapitalize="off"
        />
        <RefreshButton onClick={handleRefresh} spinning={refreshing} title="Refresh chain log" />
      </div>
    </div>
  );

  if (loading && rows.length === 0) return (
    <>
      {controls}
      <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em' }}>LOADING CHAIN LOG…</div>
    </>
  );
  if (filtered.length === 0) return (
    <>
      {controls}
      <div style={{ padding: '60px 20px', textAlign: 'center', border: '1px dashed var(--line-soft)', borderRadius: 'var(--radius-l)' }}>
        <p className="lead" style={{ margin: 0 }}>
          {filtering ? 'No chain events match the current filter.' : 'No alignment chain events yet. Register a case on-chain to start the log.'}
        </p>
      </div>
    </>
  );

  return (
    <>
      {controls}
      <div className="pr-log">
        {filtered.map(r => {
          const when    = r.occurred_at ? new Date(r.occurred_at) : null;
          const diffH   = when ? Math.floor((Date.now() - when.getTime()) / 3_600_000) : null;
          const timeStr = when == null ? `block ${r.block_number}`
                        : diffH < 1   ? 'Just now'
                        : diffH < 24  ? `${diffH}h ago`
                        :               `${Math.floor(diffH / 24)}d ago`;
          const explorerBase = CONSENSUS_CHAIN_ID === 56 ? 'https://bscscan.com' : 'https://testnet.bscscan.com';
          return (
            <div key={r.id} className="pr-log-row">
              <div className="pr-log-time">{timeStr}</div>
              <div className="pr-log-event">
                <span className="pr-log-kind approve">{r.event_name}</span>
                {r.peer_addr && (
                  <> <b>{r.peer_handle ? `${r.peer_handle} (${SHORT(r.peer_addr)})` : SHORT(r.peer_addr)}</b></>
                )}
                {r.behaviour_id && (
                  <> · <button
                    type="button"
                    onClick={() => setPeekId(r.behaviour_id)}
                    className="pr-log-evidence-link"
                    title={`Open alignment case · ${r.behaviour_id}`}
                  >
                    {r.behaviour?.title || SHORT(r.behaviour_id)}
                  </button></>
                )}
                {r.payload?.grounds && (
                  <div style={{ fontStyle: 'italic', fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                    "{r.payload.grounds}"
                  </div>
                )}
              </div>
              <div className="pr-log-hash">
                {r.tx_hash ? (
                  <a
                    href={`${explorerBase}/tx/${r.tx_hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={r.tx_hash}
                  >
                    {SHORT(r.tx_hash)} ↗
                  </a>
                ) : (
                  <span style={{ color: 'var(--ink-faint)' }}>block {r.block_number}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <BehaviourPeekModal behaviourId={peekId} onClose={() => setPeekId(null)} />
    </>
  );
}

// ── BehaviourPeekModal — light read-only popup mirroring EvidencePeekModal ───
// Fetches a single behaviour row by id and renders just enough to identify
// it from a log row click. For the full record view (with input/output JSON,
// challenge surface, etc.) the modal also links to /alignment/?case=<uuid>.
function BehaviourPeekModal({ behaviourId, onClose }) {
  const [data, setData]   = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!behaviourId) return;
    setData(null);
    setError(null);
    let cancelled = false;
    supabase.from('behaviour').select('*').eq('id', behaviourId).maybeSingle()
      .then(({ data: row, error: err }) => {
        if (cancelled) return;
        if (err)        setError(err.message);
        else if (!row)  setError('Behaviour not found — the id may belong to a row that has since been removed.');
        else            setData(row);
      });
    return () => { cancelled = true; };
  }, [behaviourId]);

  useEffect(() => {
    if (!behaviourId) return;
    const onKey = (ev) => { if (ev.key === 'Escape') onClose(); };
    const prev  = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [behaviourId, onClose]);

  if (!behaviourId) return null;

  const tierLabel = data?.tier === 1 ? 'I' : data?.tier === 2 ? 'II' : data?.tier === 3 ? 'III' : '';
  const domain    = data ? BEHAVIOUR_DOMAINS.find(d => d.id === data.domain) : null;
  const statusLabel = data ? (BH_STATUS_LABEL[data.status] || data.status) : '';

  return (
    <div className="pr-ev-modal-backdrop" onClick={onClose}>
      <div className="pr-ev-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="pr-ev-modal-close" onClick={onClose} aria-label="Close">×</button>
        {error ? (
          <>
            <div className="eyebrow" style={{ marginBottom: 10 }}>◇ Alignment case</div>
            <p className="lead" style={{ margin: 0 }}>{error}</p>
            <p className="sub" style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-faint)' }}>{behaviourId}</p>
          </>
        ) : !data ? (
          <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em' }}>LOADING CASE…</div>
        ) : (
          <>
            <div className="eyebrow" style={{ marginBottom: 10 }}>
              Alignment{tierLabel ? ` · Tier ${tierLabel}` : ''}
              {domain ? ` · Domain ${domain.n} · ${domain.title}` : ''}
              {statusLabel ? ` · ${statusLabel}` : ''}
            </div>
            <h3 className="pr-ev-modal-title">{data.title}</h3>
            <p className="pr-ev-modal-src">
              <span className="pr-ev-modal-label">Model</span> {data.model_name}{data.model_version ? ` · ${data.model_version}` : ''}
            </p>
            <p className="pr-ev-modal-id" title={`Behaviour id · ${data.id}`}>
              <span className="pr-ev-modal-label">ID</span>
              <span className="pr-ev-modal-id-value">{data.id}</span>
            </p>
            {data.summary && <p className="pr-ev-modal-body">{data.summary}</p>}
            {data.challenge_reason && (
              <p className="pr-ev-modal-quote" style={{ fontStyle: 'italic' }}>
                Challenge grounds: &ldquo;{data.challenge_reason}&rdquo;
              </p>
            )}
            <div className="pr-ev-modal-actions">
              {data.reproducer_url && (
                <a href={data.reproducer_url} target="_blank" rel="noopener noreferrer" className="pr-peer-btn">
                  Open reproducer ↗
                </a>
              )}
              <a href={`/alignment/?case=${data.id}`} className="pr-peer-btn">
                Open in archive →
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Expandable section showing everything a peer needs to vote on a behaviour:
// the actual input/output bundles, the reproducer link, sampling, and the
// three on-chain hashes. Without this the card only renders title + summary,
// which is insufficient context for a verdict.
function BehaviourFullDetails({ item }) {
  const hasContent =
    item.input_payload != null || item.output_payload != null ||
    item.reproducer_url || item.seed || item.sampling_params ||
    item.model_hash || item.input_hash || item.output_hash;
  if (!hasContent) return null;

  const fmt = (v) => typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  const block = {
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    background: 'rgba(255,255,255,0.04)', padding: '10px 12px',
    borderRadius: 6, fontFamily: 'var(--mono)', fontSize: 12,
    lineHeight: 1.5, maxHeight: 320, overflow: 'auto', margin: '6px 0 0',
  };
  const head = {
    fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em',
    opacity: 0.7, marginTop: 12,
  };

  return (
    <details style={{ margin: '12px 0 14px' }}>
      <summary style={{
        cursor: 'pointer', fontSize: 11, opacity: 0.75,
        fontFamily: 'var(--mono)', letterSpacing: '0.1em',
        textTransform: 'uppercase', padding: '4px 0',
      }}>
        View full record ↕
      </summary>
      {item.reproducer_url && (
        <>
          <div style={head}>Reproducer</div>
          <p style={{ wordBreak: 'break-all', margin: '6px 0 0', fontSize: 13 }}>
            <a href={item.reproducer_url} target="_blank" rel="noopener noreferrer"
               style={{ color: 'var(--accent-2, currentColor)' }}>
              {item.reproducer_url}
            </a>
          </p>
        </>
      )}
      {item.input_payload != null && (
        <>
          <div style={head}>Input</div>
          <pre style={block}>{fmt(item.input_payload)}</pre>
        </>
      )}
      {item.output_payload != null && (
        <>
          <div style={head}>Output</div>
          <pre style={block}>{fmt(item.output_payload)}</pre>
        </>
      )}
      {(item.seed || item.sampling_params) && (
        <>
          <div style={head}>Sampling</div>
          <pre style={block}>{fmt({ seed: item.seed, ...(item.sampling_params ?? {}) })}</pre>
        </>
      )}
      {(item.model_hash || item.input_hash || item.output_hash) && (
        <>
          <div style={head}>On-chain hashes</div>
          <div style={{ fontSize: 10, opacity: 0.6, lineHeight: 1.7, marginTop: 6, fontFamily: 'var(--mono)' }}>
            {item.model_hash  && <div>model:  {item.model_hash}</div>}
            {item.input_hash  && <div>input:  {item.input_hash}</div>}
            {item.output_hash && <div>output: {item.output_hash}</div>}
          </div>
        </>
      )}
    </details>
  );
}

// Mirror of OpenChallengePanel for the behaviour archive. Lets a peer browse
// canonised alignment records (status in [aligned, reaffirmed]) and open a
// formal challenge with written grounds. The contract enforces a 7-day
// cooldown per peer per archive — the behaviour contract has its own
// `lastChallengeAt` mapping, independent of evidence, so cooldown state is
// tracked separately here too.
function OpenChallengeBehaviourPanel({ onOpen, peerCount, cooldownSecs = 0 }) {
  const [search, setSearch]         = useState('');
  const [debounced, setDebounced]   = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const { canon, loading, hasMore, loadMore, total } = useCanonBehaviour(debounced);
  const [selected, setSelected]     = useState(null);
  const [reason, setReason]         = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!selected || reason.trim().length === 0) return;
    setSubmitting(true);
    await onOpen(selected, reason.trim());
    setSelected(null);
    setReason('');
    setSubmitting(false);
  };

  const cooldownDays = cooldownSecs > 0 ? Math.ceil(cooldownSecs / 86400) : 0;
  const cooldownDate = cooldownSecs > 0
    ? new Date(Date.now() + cooldownSecs * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    : null;

  const domainTitle = (id) =>
    BEHAVIOUR_DOMAINS.find(d => d.id === id)?.title || `Domain ${id}`;

  return (
    <div className="pr-open-challenge">
      <div className="eyebrow" style={{ marginBottom: 14 }}>◇ Open a new alignment challenge</div>
      {cooldownSecs > 0 ? (
        <p className="pr-open-challenge-sub" style={{ color: 'var(--warn)' }}>
          Alignment challenge cooldown active — you can open your next challenge in {cooldownDays} day{cooldownDays === 1 ? '' : 's'} ({cooldownDate}).
        </p>
      ) : (
      <>
      <p className="pr-open-challenge-sub">
        Select a canonised alignment record and state your grounds. Other peers will have {CHALLENGE_WINDOW_DAYS} days to vote.
        {' '}{deprecateThreshold(2, peerCount)} votes deprecates it; a defense majority reaffirms it.
      </p>

      <div style={{ margin: '0 0 14px' }}>
        <input
          type="search"
          placeholder="Search canon by title, model name…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: '100%', padding: '10px 14px', border: '1px solid var(--line-soft)', borderRadius: 'var(--radius)', background: 'var(--bg-elev)', color: 'var(--ink)', fontFamily: 'var(--mono)', fontSize: 12 }}
        />
      </div>

      {loading && canon.length === 0 ? (
        <div className="pr-open-challenge-empty">Loading alignment canon…</div>
      ) : canon.length === 0 ? (
        <div className="pr-open-challenge-empty">
          {debounced ? `No canon alignment record matches "${debounced}".` : 'No canon alignment records yet. Canonise some submissions first.'}
        </div>
      ) : (
        <>
          <div className="pr-canon-list">
            {canon.map(bh => (
              <button key={bh.id}
                className={`pr-canon-item ${selected?.id === bh.id ? 'is-selected' : ''}`}
                onClick={() => setSelected(selected?.id === bh.id ? null : bh)}>
                <span className="pr-canon-item-tier" data-tier={bh.tier}>T{bh.tier}</span>
                <span className="pr-canon-item-title">{bh.title}</span>
                <span className="pr-canon-item-src">{domainTitle(bh.domain)} · {bh.model_name}</span>
              </button>
            ))}
          </div>
          {hasMore && (
            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <button className="pr-peer-btn" onClick={loadMore} disabled={loading}>
                {loading ? 'Loading…' : `Load more${total ? ` · ${canon.length} of ${total}` : ''}`}
              </button>
            </div>
          )}
        </>
      )}

      {selected && (
        <div className="pr-challenge-form">
          <div className="pr-challenge-form-label">
            Challenging: <em>{selected.title}</em>
          </div>
          <textarea
            className="pr-challenge-textarea"
            placeholder="State your grounds clearly. What specifically is wrong about the verdict, the domain choice, the input/output binding, or the model identification?"
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={4}
          />
          <div className="pr-challenge-form-foot">
            <span className="pr-vote-hint" style={{ flex: 1 }}>
              {reason.trim().length === 0 ? 'Grounds required' : 'Ready to sign'}
            </span>
            <button
              className="pr-nominate-btn"
              disabled={reason.trim().length === 0 || submitting}
              onClick={handleSubmit}>
              {submitting ? 'Signing…' : 'Open challenge →'}
            </button>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}

function BehaviourPanel({ me, peerCount, setPendingSign, setChainErr, setChainPending }) {
  const [bhTab, setBhTab] = useState('queue');
  const [peekId, setPeekId] = useState(null);
  const { items: queue,     loading: qLoading, refetch: refetchQueue     } = useBehaviourQueue();
  const { items: contested, loading: cLoading, refetch: refetchContested } = useBehaviourContested();
  const { items: unchained, refetch: refetchUnchained }                    = useUnchainedBehaviour();

  // Behaviour-side challenge cooldown — independent of evidence. The contract
  // has its own `lastChallengeAt` mapping so a peer can be cooling down on
  // one archive while free to act on the other.
  const [bhChallengeCooldownSecs, setBhChallengeCooldownSecs] = useState(0);
  useEffect(() => {
    if (!me?.addr || !BEHAVIOUR_CONSENSUS_ADDR) return;
    getBehaviourChallengeCooldownRemaining(me.addr).then(s => setBhChallengeCooldownSecs(s ?? 0));
  }, [me]);

  // Needs-me / All-open filter + refresh, mirroring the evidence pattern.
  const [bhFilter, setBhFilter]                 = useState('mine');
  const [myBhVotes, setMyBhVotes]               = useState({}); // behaviourId → 'cast'
  const [refreshingBhQueue, setRefreshingBhQueue] = useState(false);

  // Seed myBhVotes from on-chain hasVoted (phase 0 = review) so the "Needs me"
  // filter excludes records already voted on in a prior session. No batched
  // multicall on the behaviour side yet — one RPC per item, parallelised. Fine
  // at expected queue volumes; revisit if the queue grows past a few hundred.
  useEffect(() => {
    if (!BEHAVIOUR_CONSENSUS_ADDR || !me?.addr || !queue.length) return;
    let cancelled = false;
    (async () => {
      const flags = await Promise.all(
        queue.map(it => hasVotedOnBehaviour(it.id, 0, me.addr).then(v => [it.id, v]))
      );
      if (cancelled) return;
      setMyBhVotes(prev => {
        const next = { ...prev };
        for (const [id, voted] of flags) if (voted && !next[id]) next[id] = 'cast';
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [queue, me?.addr]);

  const queueFiltered = useMemo(() => {
    if (bhFilter === 'mine') return queue.filter(it => !myBhVotes[it.id]);
    return queue;
  }, [queue, bhFilter, myBhVotes]);

  const handleRefreshBhQueue = useCallback(async () => {
    if (refreshingBhQueue) return;
    setRefreshingBhQueue(true);
    const minSpin = new Promise(r => setTimeout(r, 600));
    try { await Promise.all([refetchQueue(), refetchUnchained(), minSpin]); }
    finally { setRefreshingBhQueue(false); }
  }, [refreshingBhQueue, refetchQueue, refetchUnchained]);

  const domainTitle = (id) =>
    BEHAVIOUR_DOMAINS.find(d => d.id === id)?.title || `Domain ${id}`;

  // ── Register-on-chain ────────────────────────────────────────────────────
  // Computes a fingerprint per hash component from the off-chain payload and
  // submits to BehaviourConsensus.submitBehaviour.
  const handleRegister = useCallback(async (item) => {
    if (!BEHAVIOUR_CONSENSUS_ADDR) {
      setChainErr('Behaviour contract address not configured (VITE_BEHAVIOUR_CONSENSUS_ADDR).');
      return;
    }
    setChainErr(null);
    try {
      // Hash the off-chain bundles so the on-chain record binds to them. The
      // three hashes are real keccak256 over a key-sorted JSON canonicalisation
      // — the same derivation rule the audit-behaviour-hash edge function and
      // any independent auditor can replay against the cache. Tier I records
      // should supply a published weights digest in model_version (e.g. the
      // HuggingFace safetensors sha) so model_hash binds to a deployment
      // identity rather than just a label.
      const m = await computeBehaviourModelHash({
        model_name:    item.model_name,
        model_version: item.model_version,
      });
      const i = await computeBehaviourPayloadHash(item.input_payload);
      const o = await computeBehaviourPayloadHash(item.output_payload);

      // Persist hashes locally so the trigger / detail view can show them.
      await supabase.from('behaviour').update({
        model_hash: m, input_hash: i, output_hash: o,
      }).eq('id', item.id);

      setChainPending('Submitting behaviour on-chain…');
      const txHash = await submitBehaviourOnChain(item.id, item.tier, item.domain, m, i, o);
      await waitForTx(txHash);

      // Call verify-attestation-behaviour to flip submitted_onchain via the
      // canonical edge-function path (which checks the triple hash matches).
      await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/verify-attestation-behaviour`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey:        import.meta.env.VITE_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          action:       'register_behaviour_onchain',
          behaviour_id: item.id,
          peer_addr:    me.addr,
          tx_hash:      txHash,
        }),
      });

      setChainPending(null);
      await Promise.all([refetchQueue(), refetchUnchained()]);
    } catch (err) {
      setChainPending(null);
      setChainErr(`Register failed — ${err?.message || 'unknown error'}`);
    }
  }, [me, refetchQueue, refetchUnchained, setChainErr, setChainPending]);

  // ── Review vote ──────────────────────────────────────────────────────────
  const handleVote = useCallback((item, verdict) => {
    setPendingSign({
      action: 'attest_behaviour',
      title:  verdict === 'approve' ? 'Endorse case as aligned' : 'Mark case as misaligned',
      sub:    `Attesting "${(item.title ?? '').slice(0, 60)}" as ${verdict}.`,
      subject: item.id, verdict, phase: 'review', note: '',
      danger: verdict === 'reject',
      // Custom sign + tx path for behaviour records. `note` arrives from the
      // SignModal's editable textarea — same string flows into the EIP-712
      // signature and the cached attestation row.
      signOverride: async (note) => {
        const sig = await signBehaviourAttestation({
          behaviourId: item.id, peerAddr: me.addr,
          phase: 'review', verdict, note: note ?? '',
        }, me.addr);
        const txHash = await castBehaviourReviewVoteOnChain(item.id, verdict === 'approve');
        await waitForTx(txHash);
        await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/verify-attestation-behaviour`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey:        import.meta.env.VITE_SUPABASE_ANON_KEY,
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({
            action:       'review_vote',
            behaviour_id: item.id,
            peer_addr:    me.addr,
            peer_handle:  me.handle ?? null,
            phase:        'review',
            verdict,
            tier:         item.tier,
            note:         note ?? '',
            eip712_sig:   sig,
            tx_hash:      txHash,
          }),
        });
        await refetchQueue();
      },
    });
  }, [me, refetchQueue, setPendingSign]);

  // ── Challenge votes ──────────────────────────────────────────────────────
  const handleChallengeVote = useCallback((item, support) => {
    setPendingSign({
      action: 'attest_behaviour',
      title:  support ? 'Support challenge' : 'Defend alignment canon',
      sub:    `Voting on contested case "${(item.title ?? '').slice(0, 60)}".`,
      subject: item.id, verdict: support ? 'challenge' : 'defend', phase: 'challenge', note: '',
      danger: support,
      signOverride: async (note) => {
        const sig = await signBehaviourAttestation({
          behaviourId: item.id, peerAddr: me.addr,
          phase: 'challenge', verdict: support ? 'challenge' : 'defend', note: note ?? '',
        }, me.addr);
        const txHash = await castBehaviourChallengeVoteOnChain(item.id, support);
        await waitForTx(txHash);
        await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/verify-attestation-behaviour`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey:        import.meta.env.VITE_SUPABASE_ANON_KEY,
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({
            action:       'challenge_vote',
            behaviour_id: item.id,
            peer_addr:    me.addr,
            peer_handle:  me.handle ?? null,
            phase:        'challenge',
            verdict:      support ? 'challenge' : 'defend',
            tier:         item.tier,
            note:         note ?? '',
            eip712_sig:   sig,
            tx_hash:      txHash,
          }),
        });
        await refetchContested();
      },
    });
  }, [me, refetchContested, setPendingSign]);

  // ── Open challenge handler ─────────────────────────────────────────────────
  // Mirrors the evidence-side handleOpenChallenge but uses the behaviour
  // contract's openChallenge(id, grounds) — the grounds string is emitted in
  // the ChallengeOpened event and rendered on the contested card.
  const handleOpenChallengeBehaviour = useCallback(async (item, reason) => {
    setPendingSign({
      action: 'attest_behaviour',
      title:  'Open an alignment challenge',
      sub:    `Opening a formal challenge against "${(item.title ?? '').slice(0, 60)}". Other peers have ${CHALLENGE_WINDOW_DAYS} days to vote.`,
      subject: item.id, verdict: 'challenge', phase: 'challenge', note: reason,
      danger: true,
      // The SignModal pre-fills its textarea with `reason` and lets the peer
      // edit before signing. Whatever they end up with is the single source
      // of truth: it gets emitted on-chain as the grounds, signed into the
      // EIP-712 attestation, and stored as challenge_reason in the cache.
      signOverride: async (editedReason) => {
        if (!BEHAVIOUR_CONSENSUS_ADDR) {
          throw new Error('Behaviour contract address not configured');
        }
        const grounds = (editedReason ?? reason ?? '').trim();
        const sig = await signBehaviourAttestation({
          behaviourId: item.id, peerAddr: me.addr,
          phase: 'challenge', verdict: 'challenge', note: grounds,
        }, me.addr);
        const txHash = await openBehaviourChallengeOnChain(item.id, grounds);
        setChainPending('Confirming on-chain…');
        try { await waitForTx(txHash); }
        finally { setChainPending(null); }
        await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/verify-attestation-behaviour`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey:        import.meta.env.VITE_SUPABASE_ANON_KEY,
            Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({
            action:           'open_challenge',
            behaviour_id:     item.id,
            peer_addr:        me.addr,
            peer_handle:      me.handle ?? null,
            phase:            'challenge',
            verdict:          'challenge',
            tier:             item.tier,
            note:             grounds,
            challenge_reason: grounds,
            eip712_sig:       sig,
            tx_hash:          txHash,
          }),
        });
        await refetchContested();
        // Refresh cooldown — the 7-day clock started when the tx confirmed.
        getBehaviourChallengeCooldownRemaining(me.addr).then(s => setBhChallengeCooldownSecs(s ?? 0));
      },
    });
  }, [me, refetchContested, setChainPending, setPendingSign]);

  return (
    <div>
      <div className="pr-tabs">
        <button className={`pr-tab ${bhTab === 'queue' ? 'is-active' : ''}`} onClick={() => setBhTab('queue')}>
          Review queue <span className="count">{queue.length + contested.length}</span>
        </button>
        <button className={`pr-tab ${bhTab === 'challenge' ? 'is-active' : ''}`} onClick={() => setBhTab('challenge')}>
          Open challenge
        </button>
        <button className={`pr-tab ${bhTab === 'log' ? 'is-active' : ''}`} onClick={() => setBhTab('log')}>
          Attestation log
        </button>
        <button className={`pr-tab ${bhTab === 'chain' ? 'is-active' : ''}`} onClick={() => setBhTab('chain')}>
          Chain log
        </button>
      </div>

      {bhTab === 'log'   && <BehaviourAttestationLog />}
      {bhTab === 'chain' && (
        <>
          <OpsPanel scope="alignment" />
          <BehaviourChainEventLog />
        </>
      )}
      {bhTab === 'challenge' && (
        <OpenChallengeBehaviourPanel
          onOpen={handleOpenChallengeBehaviour}
          peerCount={peerCount}
          cooldownSecs={bhChallengeCooldownSecs}
        />
      )}

      {bhTab === 'queue' && (
      <>
      {unchained.length > 0 && (
        <div style={{
          border: '1px dashed color-mix(in oklab, var(--warn) 50%, var(--line))',
          borderRadius: 'var(--radius-l)', padding: '18px 22px', marginBottom: 24,
          background: 'color-mix(in oklab, var(--warn) 8%, var(--bg-elev))',
        }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            ◇ {unchained.length} alignment submission{unchained.length === 1 ? '' : 's'} awaiting on-chain registration
          </div>
          <p className="sub" style={{ margin: '0 0 14px' }}>
            Filed but not yet recorded. Hash the (model, input, output) bundle and submit.
          </p>
          <div style={{ display: 'grid', gap: 8 }}>
            {unchained.map(it => (
              <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderRadius: 'var(--radius)', background: 'var(--bg-elev)', border: '1px solid var(--line-soft)' }}>
                <span className="pr-review-tier" data-tier={it.tier}>
                  <span className="bar"><i /><i /><i /></span>
                  T{it.tier}
                </span>
                <span style={{ fontSize: 11, opacity: 0.7 }}>{domainTitle(it.domain)}</span>
                <span style={{ flex: 1, fontFamily: 'var(--serif)', fontSize: 14 }}>{it.title}</span>
                <button className="pr-peer-btn approve" onClick={() => handleRegister(it)}>
                  Register on-chain →
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="pr-section-head">
        <div>
          <h2>Alignment records awaiting attestation</h2>
          <p className="sub">
            AI alignment cases awaiting peer review. Same lifecycle as evidence; quorum scales with
            the shared peer registry ({peerCount ?? '…'} peers today).
          </p>
        </div>
        <div className="right">
          {[['mine', 'Needs me'], ['all', 'All open']].map(([f, label]) => (
            <button key={f} className={`pr-filter ${bhFilter === f ? 'is-active' : ''}`} onClick={() => setBhFilter(f)}>
              {label}
            </button>
          ))}
          <RefreshButton onClick={handleRefreshBhQueue} spinning={refreshingBhQueue} title="Refresh alignment queue" />
        </div>
      </div>

      {qLoading ? (
        <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em' }}>LOADING QUEUE…</div>
      ) : queueFiltered.length === 0 ? (
        <div style={{ padding: '60px 20px', textAlign: 'center', border: '1px dashed var(--line-soft)', borderRadius: 'var(--radius-l)' }}>
          <p className="lead" style={{ margin: 0 }}>
            {bhFilter === 'mine'
              ? "You've reviewed everything in the alignment queue."
              : 'The alignment queue is clear.'}
          </p>
          {bhFilter === 'mine' && queue.length > 0 && (
            <button className="pr-filter" style={{ marginTop: 16 }} onClick={() => setBhFilter('all')}>
              See all open alignment cases
            </button>
          )}
        </div>
      ) : (
        <div className="pr-review-list">
          {queueFiltered.map(item => (
            <div key={item.id} className="pr-review-card">
              <div className="pr-review-top">
                <span className="pr-review-tier" data-tier={item.tier}>
                  <span className="bar"><i /><i /><i /></span>
                  T{item.tier}
                </span>
                <span style={{ fontSize: 11, opacity: 0.7, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  {domainTitle(item.domain)}
                </span>
                <button
                  type="button"
                  onClick={() => setPeekId(item.id)}
                  className="pr-log-evidence-link"
                  title={`Open alignment case · ${item.id}`}
                  style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 11, opacity: 0.7 }}
                >
                  case {item.id.slice(0, 8)} ↗
                </button>
              </div>
              <h3 className="pr-review-title">{item.title}</h3>
              <p className="pr-review-src" style={{ opacity: 0.7, fontSize: 13, margin: '4px 0 10px' }}>
                <strong>{item.model_name}</strong>
                {item.model_version && <span> · {item.model_version}</span>}
              </p>
              {item.summary && <p className="pr-review-excerpt">{item.summary}</p>}
              <BehaviourFullDetails item={item} />
              <AttestBar
                approvals={item.approve_count ?? 0}
                rejections={item.reject_count ?? 0}
                canonThresh={canonizeThreshold(item.tier, peerCount)}
                expelThresh={expelThreshold(peerCount)}
              />
              <div className="pr-review-actions">
                <button className="pr-peer-btn approve" onClick={() => handleVote(item, 'approve')}>
                  Aligned
                </button>
                <button className="pr-peer-btn danger" onClick={() => handleVote(item, 'reject')}>
                  Misaligned
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {contested.length > 0 && (
        <>
          <div className="pr-section-head" style={{ marginTop: 40 }}>
            <div>
              <h2>Contested alignment records</h2>
              <p className="sub">
                A challenge window of {CHALLENGE_WINDOW_DAYS} days is open. Reaffirm or deprecate.
              </p>
            </div>
          </div>
          {cLoading ? (
            <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--ink-faint)' }}>LOADING…</div>
          ) : (
            <div className="pr-review-list">
              {contested.map(item => (
                <div key={item.id} className="pr-review-card">
                  <div className="pr-review-top">
                    <span className="pr-review-tier" data-tier={item.tier}>
                      <span className="bar"><i /><i /><i /></span>
                      T{item.tier}
                    </span>
                    <span style={{ fontSize: 11, opacity: 0.7, textTransform: 'uppercase' }}>
                      {domainTitle(item.domain)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPeekId(item.id)}
                      className="pr-log-evidence-link"
                      title={`Open alignment case · ${item.id}`}
                      style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 11, opacity: 0.7 }}
                    >
                      case {item.id.slice(0, 8)} ↗
                    </button>
                  </div>
                  <h3 className="pr-review-title">{item.title}</h3>
                  <p className="pr-review-src" style={{ opacity: 0.7, fontSize: 13, margin: '4px 0 10px' }}>
                    <strong>{item.model_name}</strong>
                    {item.model_version && <span> · {item.model_version}</span>}
                  </p>
                  {item.summary && <p className="pr-review-excerpt">{item.summary}</p>}
                  {item.challenge_reason && (
                    <p className="pr-review-excerpt" style={{ fontStyle: 'italic' }}>
                      Grounds: {item.challenge_reason}
                    </p>
                  )}
                  <BehaviourFullDetails item={item} />
                  <AttestBar
                    approvals={item.defense_votes ?? 0}
                    rejections={item.challenge_votes ?? 0}
                    canonThresh={peerCount ?? 1}
                    expelThresh={deprecateThreshold(item.tier, peerCount)}
                  />
                  <div className="pr-review-actions">
                    <button className="pr-peer-btn approve" onClick={() => handleChallengeVote(item, false)}>
                      Defend
                    </button>
                    <button className="pr-peer-btn danger" onClick={() => handleChallengeVote(item, true)}>
                      Support challenge
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      </>
      )}
      <BehaviourPeekModal behaviourId={peekId} onClose={() => setPeekId(null)} />
    </div>
  );
}

function VerifiedPanel({ me, role, peerCount, nomineeThreshold, revokeThreshold, nominationsOpen, seedPhaseK }) {
  // Record-type toggle: evidence is the default surface; behaviour is the
  // alignment archive companion. The two share the peer registry but use
  // separate contracts, tables, and edge functions.
  const [recordType, setRecordType] = useState('evidence');
  const [tab, setTab]           = useState('queue');
  const [filter, setFilter]     = useState('mine');
  const [myVotes, setMyVotes]   = useState({});        // evidenceId → 'approve'|'reject'
  const [myChallengeVotes, setMyChallengeVotes] = useState({}); // evidenceId → 'challenge'|'defend'
  const [myEndorse, setMyEndorse]     = useState({});
  const [myRevokeVote, setMyRevokeVote] = useState({});
  const [pendingSign, setPendingSign]         = useState(null);
  const [chainErr, setChainErr]               = useState(null);
  const [chainPending, setChainPending]       = useState(null); // shown while waiting for tx confirmation
  const [challengeCooldownSecs, setChallengeCooldownSecs] = useState(0);

  // Fetch cooldown on mount so the panel reflects current state immediately.
  useEffect(() => {
    if (!CONSENSUS_ADDR || !me?.addr) return;
    getChallengeCooldownRemaining(me.addr).then(s => setChallengeCooldownSecs(s ?? 0));
  }, [me?.addr]);

  const { queue,     loading: qLoading, refetch: refetchQueue }  = usePendingEvidence();
  const { contested, loading: cLoading }  = useContestedEvidence();
  const { items: unchained, refetch: refetchUnchained } = useUnchainedPending();

  const [refreshingQueue, setRefreshingQueue] = useState(false);
  const handleRefreshQueue = useCallback(async () => {
    if (refreshingQueue) return;
    setRefreshingQueue(true);
    const minSpin = new Promise(r => setTimeout(r, 600));
    try { await Promise.all([refetchQueue(), refetchUnchained(), minSpin]); }
    finally { setRefreshingQueue(false); }
  }, [refreshingQueue, refetchQueue, refetchUnchained]);

  // Seed myVotes / myChallengeVotes from on-chain hasVoted so a page reload
  // does not let the user retry a vote that the contract will refuse.
  // hasVoted only records that they voted, not which side — but that is
  // enough to disable the buttons.
  //
  // Single Multicall3 per queue/contested mount. Previously N×RPC where N is
  // queue length — at 200 pending items that was 200 sequential round-trips
  // per page load per peer; now it's one.
  useEffect(() => {
    if (!CONSENSUS_ADDR || !me?.addr || !queue.length) return;
    let cancelled = false;
    (async () => {
      const flags = await hasVotedManyOnChain(queue.map(item => item.id), 0, me.addr);
      if (cancelled) return;
      setMyVotes(prev => {
        const next = { ...prev };
        queue.forEach(item => { if (flags.get(item.id) && !next[item.id]) next[item.id] = 'cast'; });
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [queue, me?.addr]);

  useEffect(() => {
    if (!CONSENSUS_ADDR || !me?.addr || !contested.length) return;
    let cancelled = false;
    (async () => {
      const flags = await hasVotedManyOnChain(contested.map(item => item.id), 1, me.addr);
      if (cancelled) return;
      setMyChallengeVotes(prev => {
        const next = { ...prev };
        contested.forEach(item => { if (flags.get(item.id) && !next[item.id]) next[item.id] = 'cast'; });
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [contested, me?.addr]);

  const queueFiltered = useMemo(() => {
    if (filter === 'mine') return queue.filter(e => !myVotes[e.id]);
    return queue;
  }, [queue, filter, myVotes]);

  const reviewCount    = useMyReviewCount(me?.addr);
  const bhReviewCount  = useMyBehaviourReviewCount(me?.addr);
  const bhPendingCount = useBehaviourNeedsReviewCount(me?.addr);

  // ── Review vote handler ────────────────────────────────────────────────────
  const handleVote = (item, verdict) => {
    setPendingSign({
      action: 'attest_evidence',
      title:  verdict === 'approve' ? 'Approve evidence' : 'Reject evidence',
      sub:    `Attesting "${item.title.slice(0, 60)}${item.title.length > 60 ? '…' : ''}" as ${verdict}.`,
      subject: item.id, verdict, phase: 'review', note: '',
      danger: verdict === 'reject',
      onConfirm: async (sig) => {
        setChainErr(null);
        let txHash = null;
        if (CONSENSUS_ADDR) {
          try {
            txHash = await castReviewVoteOnChain(item.id, verdict === 'approve');
          } catch (txErr) {
            setChainErr(txErr?.message?.includes('rejected')
              ? 'Transaction rejected — vote not recorded.'
              : `On-chain call failed — ${txErr?.message || 'unknown error'}`);
            return;
          }
          setChainPending('Confirming on-chain…');
          try { await waitForTx(txHash); }
          catch (txErr) {
            setChainPending(null);
            setChainErr('Transaction reverted — vote not recorded.');
            return;
          }
          setChainPending(null);
        }
        try {
          await castReviewVote(item, verdict, me.addr, me.handle, null, sig, txHash, peerCount);
        } catch (syncErr) {
          if (!txHash) {
            setChainErr(`Failed to record vote — ${syncErr?.message || 'unknown error'}`);
            return;
          }
        }
        setMyVotes(v => ({ ...v, [item.id]: verdict }));
      },
    });
  };

  // ── Challenge vote handler ─────────────────────────────────────────────────
  const handleChallengeVote = (item, supportChallenge) => {
    const label = supportChallenge ? 'Support challenge' : 'Defend canon';
    setPendingSign({
      action:  supportChallenge ? 'challenge_evidence' : 'defend_evidence',
      title:   label,
      sub:     `Voting to ${supportChallenge ? 'deprecate' : 'reaffirm'} "${item.title.slice(0, 60)}…"`,
      subject: item.id, verdict: supportChallenge ? 'challenge' : 'defend',
      phase:   'challenge', note: '',
      danger:  supportChallenge,
      onConfirm: async (sig) => {
        setChainErr(null);
        let txHash = null;
        if (CONSENSUS_ADDR) {
          try {
            txHash = await castChallengeVoteOnChain(item.id, supportChallenge);
          } catch (txErr) {
            setChainErr(txErr?.message?.includes('rejected')
              ? 'Transaction rejected — vote not recorded.'
              : `On-chain call failed — ${txErr?.message || 'unknown error'}`);
            return;
          }
          setChainPending('Confirming on-chain…');
          try { await waitForTx(txHash); }
          catch (txErr) {
            setChainPending(null);
            setChainErr('Transaction reverted — vote not recorded.');
            return;
          }
          setChainPending(null);
        }
        try {
          await castChallengeVote(item, supportChallenge, me.addr, me.handle, null, sig, txHash, peerCount);
        } catch (syncErr) {
          if (!txHash) {
            setChainErr(`Failed to record vote — ${syncErr?.message || 'unknown error'}`);
            return;
          }
        }
        setMyChallengeVotes(v => ({ ...v, [item.id]: supportChallenge ? 'challenge' : 'defend' }));
      },
    });
  };

  // ── Endorse nominee handler ────────────────────────────────────────────────
  const handleEndorse = useCallback((nominee) => {
    setPendingSign({
      action:  'endorse_nominee',
      title:   'Endorse nomination',
      sub:     `Adding your endorsement for ${SHORT(nominee.addr)}. This is recorded on-chain.`,
      subject: nominee.addr,
      verdict: 'endorse',
      danger:  false,
      onConfirm: async () => {
        await endorseNomineeOnChain(nominee.addr);
      },
    });
  }, [me]);

  // ── Revocation motion handler ──────────────────────────────────────────────
  const handleMotionRevoke = useCallback((peerAddr) => {
    setPendingSign({
      action:  'motion_revoke',
      title:   'Motion to revoke peer',
      sub:     `Opening a revocation motion against ${SHORT(peerAddr)}. Your vote is cast immediately.`,
      subject: peerAddr,
      verdict: 'revoke',
      danger:  true,
      onConfirm: async () => {
        await motionRevokeOnChain(peerAddr);
      },
    });
  }, [me]);

  const handleVoteRevoke = useCallback((peerAddr) => {
    setPendingSign({
      action:  'vote_revoke',
      title:   'Vote to revoke peer',
      sub:     `Casting your revocation vote against ${SHORT(peerAddr)}.`,
      subject: peerAddr,
      verdict: 'revoke',
      danger:  true,
      onConfirm: async () => {
        await voteRevokeOnChain(peerAddr);
      },
    });
  }, [me]);

  // ── Lapse on-chain handler ────────────────────────────────────────────────
  const handleLapseChain = useCallback((item) => {
    setPendingSign({
      action:  'mark_lapsed',
      title:   'Record lapse on-chain',
      sub:     `The 30-day review window for "${item.title.slice(0, 60)}…" has expired. Recording the lapsed state on-chain.`,
      subject: item.id,
      verdict: 'lapse',
      danger:  false,
      onConfirm: async () => {
        if (!CONSENSUS_ADDR) return;
        let txHash;
        try {
          txHash = await markLapsedOnChain(item.id);
        } catch (txErr) {
          setChainErr(txErr?.message?.includes('rejected')
            ? 'Transaction rejected.'
            : `On-chain call failed — ${txErr?.message || 'unknown error'}`);
          return;
        }
        setChainPending('Confirming on-chain…');
        try { await waitForTx(txHash); }
        catch (txErr) {
          setChainPending(null);
          setChainErr('Transaction reverted — lapse not recorded on-chain.');
          return;
        }
        setChainPending(null);
      },
    });
  }, [me]);

  // ── Finalize challenge handler (after 21-day window) ─────────────────────
  const handleFinalizeChallenge = useCallback((item) => {
    setPendingSign({
      action:  'finalize_challenge',
      title:   'Finalize challenge',
      sub:     `The 21-day window for "${item.title.slice(0, 60)}…" has closed. Finalizing the outcome.`,
      subject: item.id,
      verdict: 'finalize',
      danger:  false,
      onConfirm: async () => {
        setChainErr(null);
        let txHash = null;
        if (CONSENSUS_ADDR) {
          try {
            txHash = await finalizeChallengeOnChain(item.id);
          } catch (txErr) {
            setChainErr(txErr?.message?.includes('rejected')
              ? 'Transaction rejected.'
              : `On-chain call failed — ${txErr?.message || 'unknown error'}`);
            return;
          }
          setChainPending('Confirming on-chain…');
          try { await waitForTx(txHash); }
          catch (txErr) {
            setChainPending(null);
            setChainErr('Transaction reverted — finalization not recorded on-chain.');
            return;
          }
          setChainPending(null);
        }
        try {
          await finalizeChallengeSupabase(item, me.addr, peerCount, txHash);
        } catch (syncErr) {
          setChainErr(`Failed to finalize challenge — ${syncErr?.message || 'unknown error'}`);
        }
      },
    });
  }, [me, peerCount]);

  // ── Register-on-chain handler — promotes a pending submission ─────────────
  const handleRegisterOnchain = useCallback(async (item) => {
    setChainErr(null);
    if (!CONSENSUS_ADDR) return;
    // Compute the same canonical hash the edge function will verify.  If the
    // unchained-pending row is missing any field, computeContentHash treats it
    // as the empty string — matches the edge function.
    const contentHash = await computeContentHash({
      title:     item.title,
      source:    item.source,
      year:      item.year,
      excerpt:   item.excerpt,
      link:      item.link,
      tier:      Number(item.tier),
      pillar_id: item.pillarId || item.pillar_id,
    });
    let txHash;
    try {
      txHash = await submitEvidenceOnChain(item.id, Number(item.tier), contentHash);
    } catch (txErr) {
      setChainErr(txErr?.message?.includes('rejected')
        ? 'Transaction rejected — submission not registered.'
        : `On-chain call failed — ${txErr?.message || 'unknown error'}`);
      return;
    }
    setChainPending('Confirming on-chain…');
    try { await waitForTx(txHash); }
    catch (txErr) {
      setChainPending(null);
      setChainErr('Transaction reverted — submission not registered.');
      return;
    }
    setChainPending(null);
    try {
      await markEvidenceOnchain(item.id, me.addr, txHash);
    } catch (syncErr) {
      // On-chain succeeded; cache will catch up via indexer.
    }
    refetchUnchained();
  }, [me, refetchUnchained]);

  // ── Open challenge handler ─────────────────────────────────────────────────
  const handleOpenChallenge = useCallback(async (item, reason) => {
    setPendingSign({
      action: 'open_challenge',
      title:  'Open a challenge',
      sub:    `Opening a formal challenge against "${item.title.slice(0, 60)}…". Other peers have ${CHALLENGE_WINDOW_DAYS} days to vote.`,
      subject: item.id, verdict: 'challenge',
      phase:   'challenge', note: reason,
      danger:  true,
      onConfirm: async (sig) => {
        setChainErr(null);
        let txHash = null;
        if (CONSENSUS_ADDR) {
          try {
            txHash = await openChallengeOnChain(item.id);
          } catch (txErr) {
            setChainErr(txErr?.message?.includes('rejected')
              ? 'Transaction rejected — challenge not recorded.'
              : `On-chain call failed — ${txErr?.message || 'unknown error'}`);
            return;
          }
          setChainPending('Confirming on-chain…');
          try { await waitForTx(txHash); }
          catch (txErr) {
            setChainPending(null);
            setChainErr('Transaction reverted — challenge not recorded.');
            return;
          }
          setChainPending(null);
        }
        try {
          await openChallenge(item, me.addr, me.handle, reason, sig, txHash, peerCount);
        } catch (syncErr) {
          if (!txHash) {
            setChainErr(`Failed to record challenge — ${syncErr?.message || 'unknown error'}`);
          }
        }
        // Refresh cooldown regardless of sync outcome — the on-chain cooldown
        // started the moment the tx confirmed.
        if (CONSENSUS_ADDR) {
          getChallengeCooldownRemaining(me.addr).then(s => setChallengeCooldownSecs(s ?? 0));
        }
      },
    });
  }, [me]);

  return (
    <div>
      <IdentityHeader
        me={me} role={role}
        pendingCount={queue.filter(e => !myVotes[e.id]).length}
        reviewCount={reviewCount}
        bhPendingCount={bhPendingCount}
        bhReviewCount={bhReviewCount}
      />

      {/* Top-level toggle: evidence | alignment | peers (shared registry) */}
      <div className="pr-tabs" style={{ marginBottom: 8, borderBottom: '1px solid var(--line-soft)' }}>
        <button
          className={`pr-tab ${recordType === 'evidence' ? 'is-active' : ''}`}
          onClick={() => setRecordType('evidence')}
        >
          Evidence
        </button>
        <button
          className={`pr-tab ${recordType === 'behaviour' ? 'is-active' : ''}`}
          onClick={() => setRecordType('behaviour')}
        >
          Alignment
        </button>
        <button
          className={`pr-tab ${recordType === 'peers' ? 'is-active' : ''}`}
          onClick={() => setRecordType('peers')}
        >
          Peer registry
        </button>
      </div>

      {recordType === 'behaviour' && (
        <BehaviourPanel
          me={me}
          peerCount={peerCount}
          setPendingSign={setPendingSign}
          setChainErr={setChainErr}
          setChainPending={setChainPending}
        />
      )}

      {recordType === 'peers' && (
        <PeerRegistryTab
          me={me}
          nomineeThreshold={nomineeThreshold}
          revokeThreshold={revokeThreshold}
          nominationsOpen={nominationsOpen}
          seedPhaseK={seedPhaseK}
          peerCount={peerCount}
          onEndorse={handleEndorse}
          onMotionRevoke={handleMotionRevoke}
          onVoteRevoke={handleVoteRevoke}
        />
      )}

      {recordType === 'evidence' && (
      <>
      <div className="pr-tabs">
        <button className={`pr-tab ${tab === 'queue' ? 'is-active' : ''}`} onClick={() => setTab('queue')}>
          Review queue <span className="count">{queue.length}</span>
        </button>
        <button className={`pr-tab ${tab === 'challenges' ? 'is-active' : ''}`} onClick={() => setTab('challenges')}>
          Challenges <span className="count">{contested.length}</span>
        </button>
        <button className={`pr-tab ${tab === 'log' ? 'is-active' : ''}`} onClick={() => setTab('log')}>
          Attestation log
        </button>
        <button className={`pr-tab ${tab === 'chain' ? 'is-active' : ''}`} onClick={() => setTab('chain')}>
          Chain log
        </button>
      </div>

      {/* ── Review queue ── */}
      {tab === 'queue' && (
        <section>
          {unchained.length > 0 && (
            <div className="pr-unchained" style={{
              border: '1px dashed color-mix(in oklab, var(--warn) 50%, var(--line))',
              borderRadius: 'var(--radius-l)', padding: '18px 22px', marginBottom: 24,
              background: 'color-mix(in oklab, var(--warn) 8%, var(--bg-elev))',
            }}>
              <div className="eyebrow" style={{ marginBottom: 10 }}>
                ◇ {unchained.length} submission{unchained.length === 1 ? '' : 's'} awaiting on-chain registration
              </div>
              <p className="sub" style={{ margin: '0 0 14px' }}>
                These are filed but not yet recorded on the contract. The review queue only shows
                submissions that exist on-chain — register them so peers can vote.
              </p>
              <div style={{ display: 'grid', gap: 8 }}>
                {unchained.map(it => (
                  <div key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderRadius: 'var(--radius)', background: 'var(--bg-elev)', border: '1px solid var(--line-soft)' }}>
                    <span className="pr-review-tier" data-tier={it.tier}>
                      <span className="bar"><i /><i /><i /></span>
                      T{it.tier}
                    </span>
                    <span style={{ flex: 1, fontFamily: 'var(--serif)', fontSize: 14 }}>{it.title}</span>
                    <button className="pr-peer-btn approve" onClick={() => handleRegisterOnchain(it)}>
                      Register on-chain →
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="pr-section-head">
            <div>
              <h2>Submissions awaiting attestation</h2>
              <p className="sub">
                Each vote is a wallet-signed record. Thresholds scale with the active peer count ({peerCount ?? '…'} peers today).
                Sign what resonates.
              </p>
            </div>
            <div className="right">
              {[['mine', 'Needs me'], ['all', 'All open']].map(([f, label]) => (
                <button key={f} className={`pr-filter ${filter === f ? 'is-active' : ''}`} onClick={() => setFilter(f)}>
                  {label}
                </button>
              ))}
              <RefreshButton onClick={handleRefreshQueue} spinning={refreshingQueue} title="Refresh queue" />
            </div>
          </div>

          {qLoading ? (
            <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em' }}>LOADING QUEUE…</div>
          ) : queueFiltered.length === 0 ? (
            <div style={{ padding: '60px 20px', textAlign: 'center', border: '1px dashed var(--line-soft)', borderRadius: 'var(--radius-l)' }}>
              <p className="lead" style={{ margin: 0 }}>
                {filter === 'mine' ? "You've reviewed everything in the queue." : "The queue is clear. All submissions have been resolved."}
              </p>
              {filter === 'mine' && queue.length > 0 && (
                <button className="pr-filter" style={{ marginTop: 16 }} onClick={() => setFilter('all')}>See all open submissions</button>
              )}
            </div>
          ) : (
            <div className="pr-review-list">
              {queueFiltered.map(item => (
                <ReviewCard key={item.id} item={item} myVerdict={myVotes[item.id] || null} onVote={handleVote} onLapseChain={handleLapseChain} meAddr={me.addr} peerCount={peerCount} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── Challenges ── */}
      {tab === 'challenges' && (
        <section>
          <div className="pr-section-head">
            <div>
              <h2>Challenges to canon evidence</h2>
              <p className="sub">
                When canon evidence is contested, the network has {CHALLENGE_WINDOW_DAYS} days to vote.
                A supermajority deprecates it. A defense majority reaffirms it — making it harder to challenge again.
              </p>
            </div>
          </div>

          {cLoading ? (
            <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em' }}>LOADING…</div>
          ) : contested.length > 0 && (
            <>
              <div className="eyebrow" style={{ marginBottom: 16 }}>◇ Active challenges · {contested.length}</div>
              <div className="pr-review-list" style={{ marginBottom: 40 }}>
                {contested.map(item => (
                  <ChallengeCard key={item.id} item={item} myVote={myChallengeVotes[item.id] || null} onVote={handleChallengeVote} onFinalize={handleFinalizeChallenge} peerCount={peerCount} meAddr={me.addr} />
                ))}
              </div>
            </>
          )}

          <OpenChallengePanel onOpen={handleOpenChallenge} peerCount={peerCount} cooldownSecs={challengeCooldownSecs} />
        </section>
      )}

      {/* Peer registry is now promoted to a top-level toggle (above) since
          the same registry governs both evidence and alignment. */}

      {/* ── Attestation log ── */}
      {tab === 'log' && (
        <section>
          <div className="pr-section-head">
            <div>
              <h2>Attestation log</h2>
              <p className="sub">Every signed action — approvals, rejections, challenges, defenses. The public, append-only record of who said what and when.</p>
            </div>
          </div>
          <ActivityLog />
        </section>
      )}

      {/* ── Chain log (indexed from EvidenceConsensus events) ── */}
      {tab === 'chain' && (
        <section>
          <div className="pr-section-head">
            <div>
              <h2>Chain log</h2>
              <p className="sub">
                Indexed events from the consensus contract. The chain is the receipt;
                this is the receipt.
              </p>
            </div>
          </div>
          <OpsPanel />
          <ChainEventLog me={me} role={role} />
        </section>
      )}
      </>
      )}

      <footer className="pr-footnote">
        <div>
          <b>Thresholds scale with the network</b>
          Every vote count is a percentage of the active peers, not a fixed number. With few peers a single attestation can canonize; as the network grows, the same share of peers is always needed — so consensus stays just as hard to reach, and no small group can dominate.
        </div>
        <div>
          <b>Truth can evolve</b>
          Canon evidence can be challenged. A supermajority deprecates it — the history of revision stays visible.
        </div>
        <div>
          <b>The chain is the receipt</b>
          Attestations are append-only. They cannot be edited or hidden. The blockchain figures itself out.
        </div>
      </footer>

      {chainPending && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-elev)', color: 'var(--ink-soft)',
          padding: '10px 20px', borderRadius: 'var(--radius)',
          fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em',
          border: '1px solid var(--line)', zIndex: 9999, maxWidth: '90vw', textAlign: 'center',
        }}>
          {chainPending}
        </div>
      )}

      {chainErr && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'color-mix(in oklab, var(--warn) 85%, var(--bg))',
          color: 'var(--bg)', padding: '10px 20px', borderRadius: 'var(--radius)',
          fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em',
          zIndex: 9999, maxWidth: '90vw', textAlign: 'center', cursor: 'pointer',
        }} onClick={() => setChainErr(null)}>
          {chainErr}
        </div>
      )}

      <SignModal
        open={!!pendingSign}
        payload={pendingSign}
        danger={pendingSign?.danger}
        signerAddr={me.addr}
        onCancel={() => setPendingSign(null)}
        onSign={async (editedNote) => {
          const sign = pendingSign;
          if (sign) sign.note = editedNote ?? sign.note ?? '';
          setPendingSign(null);
          // Behaviour-side actions provide their own signOverride that signs
          // with the behaviour EIP-712 domain and dispatches to the behaviour
          // contract. The evidence path keeps the original signAttestation
          // flow. Either way, the edited deliberation note flows through.
          if (sign?.signOverride) {
            try { await sign.signOverride(sign.note ?? ''); }
            catch (err) {
              setChainErr(err?.code === 4001
                ? 'Signature rejected — attestation not recorded.'
                : `Alignment attestation failed — ${err?.message || 'unknown error'}`);
            }
            return;
          }
          if (!sign?.onConfirm) return;

          let sig = null;
          if (SIG_REQUIRED_ACTIONS.has(sign.action)) {
            try {
              sig = await signAttestation({
                evidenceId: sign.subject || '',
                phase:      sign.phase   || (sign.action === 'open_challenge' ? 'challenge' : 'review'),
                verdict:    sign.verdict || '',
                note:       sign.note    || '',
              }, me.addr);
            } catch (err) {
              setChainErr(err?.code === 4001
                ? 'Signature rejected — attestation not recorded.'
                : `Signature failed — ${err?.message || 'unknown error'}`);
              return;
            }
            if (!sig) {
              setChainErr('Signature missing — attestation not recorded.');
              return;
            }
          }

          await sign.onConfirm(sig, sign.note ?? '');
        }}
      />
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────
export default function PeerReview() {
  const [wallet, setWallet]                   = useState(null);
  const [isPeer, setIsPeer]                   = useState(false);
  const [isGenesis, setIsGenesis]             = useState(false);
  const [connecting, setConnecting]           = useState(false);
  const [connectErr, setConnectErr]           = useState(null);
  const [peerHandle, setPeerHandle]           = useState(null);
  const [peerCount, setPeerCount]             = useState(null);
  const [nomineeThresh, setNomineeThresh]     = useState(null);
  const [revokeThresh, setRevokeThresh]       = useState(null);
  const [nomineeCount, setNomineeCount]       = useState(null);
  const [attestationCount, setAttestationCount] = useState(null);
  const [nomOpen, setNomOpen]                 = useState(null);
  const [seedK, setSeedK]                     = useState(null);

  // Fetch public contract state (no wallet needed)
  const refreshContractState = useCallback(() => {
    if (CONSENSUS_ADDR) {
      getActivePeerCount().then(n => { if (n !== null) setPeerCount(n); });
      getNomineeThreshold().then(n => { if (n !== null) setNomineeThresh(n); });
      getRevokeThreshold().then(n => { if (n !== null) setRevokeThresh(n); });
      isNominationsOpen().then(setNomOpen);
      getSeedPhaseK().then(setSeedK);
      // Aggregated view — one call instead of N×2.
      getNomineesAggregated().then(list => setNomineeCount(list.length)).catch(() => {});
    }
    supabase.from('attestations').select('*', { count: 'exact', head: true })
      .then(({ count }) => { if (count !== null) setAttestationCount(count); });
  }, []);

  useEffect(() => {
    // Warm the lazy wallet-impl chunk after first paint so the connect / vote
    // flow doesn't pay the chunk-fetch round-trip on the user's first click.
    prefetchWallet();
    refreshContractState();
    const onVisible = () => { if (document.visibilityState === 'visible') refreshContractState(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refreshContractState]);

  const disconnect = useCallback(() => {
    setWallet(null); setIsPeer(false); setIsGenesis(false); setPeerHandle(null);
  }, []);

  // ── Wallet event listeners ────────────────────────────────────────────────
  // Attach at the component level (not inside handleConnect) so they are
  // installed once and cleaned up on unmount — fixes the "every reconnect
  // adds another listener" leak.
  useEffect(() => {
    if (!window.ethereum) return;

    const onAccountsChanged = (accounts) => {
      const next = accounts && accounts[0];
      if (!next) { disconnect(); return; }
      setWallet(next);
      setIsPeer(false);
      setIsGenesis(false);
      setPeerHandle(null);
      if (CONSENSUS_ADDR) {
        isPeerActive(next).then(active => {
          setIsPeer(active);
          if (active) isGenesisPeer(next).then(setIsGenesis);
        });
        getPeerHandle(next).then(h => { if (h) setPeerHandle(h); });
      }
    };

    const onChainChanged = () => window.location.reload();

    window.ethereum.on?.('accountsChanged', onAccountsChanged);
    window.ethereum.on?.('chainChanged',    onChainChanged);
    return () => {
      window.ethereum.removeListener?.('accountsChanged', onAccountsChanged);
      window.ethereum.removeListener?.('chainChanged',    onChainChanged);
    };
  }, [disconnect]);

  const handleConnect = async () => {
    if (!window.ethereum) {
      if (isMobile()) {
        window.location.href = metamaskDeepLink();
        return;
      }
      setConnectErr('MetaMask not found. Install it at metamask.io and reload.');
      return;
    }
    setConnecting(true);
    setConnectErr(null);
    try {
      const { addr } = await connectWallet();
      if (CONSENSUS_ADDR) await switchToTargetChain();

      // Authorization: on-chain isActivePeer is the source of truth.  Wallet
      // connection by itself already proves key control — a separate
      // signLoginChallenge step would not add any property the on-chain check
      // doesn't already provide.
      const peer    = CONSENSUS_ADDR ? await isPeerActive(addr) : false;
      const genesis = CONSENSUS_ADDR && peer ? await isGenesisPeer(addr) : false;

      setWallet(addr);
      setIsPeer(peer);
      setIsGenesis(genesis);

      if (peer && CONSENSUS_ADDR) {
        const handle = await getPeerHandle(addr);
        if (handle) setPeerHandle(handle);
      }
    } catch (err) {
      if (err.code !== 4001) setConnectErr(err.message || 'Connection failed.');
    } finally {
      setConnecting(false);
    }
  };

  const me = wallet ? {
    addr:       wallet,
    handle:     peerHandle,
    nameSource: peerHandle ? 'self' : 'none',
  } : null;

  useEffect(() => { document.body.style.overflow = ''; }, []);

  const role    = !isPeer ? 'unverified' : isGenesis ? 'elder' : 'peer';
  const navRole = role === 'unverified' ? 'unverified' : role === 'elder' ? 'verified' : 'verified';

  return (
    <div className="pr-shell">
      <Nav wallet={wallet} role={navRole} onDisconnect={disconnect} />

      {!wallet && (
        <>
          <ConnectScreen onConnect={handleConnect} connecting={connecting} peerCount={peerCount} nomineeCount={nomineeCount} attestationCount={attestationCount} />
          {connectErr && (
            <div style={{
              position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
              background: 'var(--danger)', color: '#fff', padding: '10px 20px',
              borderRadius: 'var(--radius)', fontFamily: 'var(--mono)', fontSize: 11,
              letterSpacing: '0.1em', zIndex: 9999, maxWidth: '90vw', textAlign: 'center',
            }}>
              {connectErr}
            </div>
          )}
        </>
      )}

      {wallet && !isPeer && (
        <NotAPeerScreen addr={wallet} onDisconnect={disconnect} />
      )}

      {wallet && isPeer && (
        <main className="pr-wrap">
          <VerifiedPanel
            me={me}
            role={role}
            peerCount={peerCount}
            nomineeThreshold={nomineeThresh}
            revokeThreshold={revokeThresh}
            nominationsOpen={nomOpen}
            seedPhaseK={seedK}
          />
        </main>
      )}
    </div>
  );
}
