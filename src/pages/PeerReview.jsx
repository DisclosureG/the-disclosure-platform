import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { BrandMark } from '../components/Sigil';
import {
  canonizeThreshold, expelThreshold, deprecateThreshold,
  PENDING_WINDOW_DAYS, CHALLENGE_WINDOW_DAYS, daysRemaining,
  usePendingEvidence, useContestedEvidence, useCanonEvidence, useAttestationLog,
  useUnchainedPending, useChainEvents, useTamperAlerts, useHeartbeats,
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
} from '../lib/wallet';
import metamaskFox from '../assets/metamask-fox.svg';
import '../styles/interstellar.css';
import '../styles/peer-review.css';

// ── Helpers ──────────────────────────────────────────────────────────────────
const SHORT = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
const NAME_OF = (p) => p.handle || SHORT(p.addr);


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

function NameBadge({ source, small }) {
  if (!source || source === 'none') return null;
  const cfg = source === 'ens'
    ? { label: 'ENS', cls: 'ok', title: 'Resolved via ENS reverse lookup' }
    : { label: 'Self-asserted', cls: '', title: 'Set by the peer on first sign-in' };
  return (
    <span className={`pr-tag ${cfg.cls}`} title={cfg.title}
      style={{ marginLeft: 8, transform: 'translateY(-2px)', padding: small ? '3px 7px' : '5px 10px', fontSize: small ? 8 : 9 }}>
      {cfg.cls && <span className="pr-tag-dot" />}
      {cfg.label}
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
function IdentityHeader({ me, role, pendingCount, reviewCount }) {
  const tags = [];
  if (role === 'elder') tags.push({ label: 'Genesis peer', cls: 'elder' });
  if (role === 'peer' || role === 'elder') tags.push({ label: 'Verified · can attest', cls: 'ok' });
  tags.push({ label: me.bio, cls: '' });

  const tenureMo = Math.floor(
    (Date.now() - new Date(me.joined).getTime()) / (1000 * 60 * 60 * 24 * 30)
  );

  return (
    <section className="pr-identity">
      <div className="pr-id-main">
        <Jazzicon addr={me.addr} size={76} ring />
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
        <div className="pr-id-stat"><b>{reviewCount}</b><span>Reviews signed</span></div>
        <div className="pr-id-stat"><b>{me.endorsedBy}</b><span>Endorsed by</span></div>
        <div className="pr-id-stat"><b>{pendingCount}</b><span>Needs review</span></div>
        <div className="pr-id-stat">
          <b>{tenureMo}<small style={{ fontSize: '0.5em', marginLeft: 4, color: 'var(--ink-faint)' }}>mo</small></b>
          <span>Tenure</span>
        </div>
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
          <span>Submitted by <b>{item.submittedBy?.startsWith('guest:') ? 'guest · ' + item.submittedBy.slice(6) : (item.submittedBy || 'anonymous')}</b></span>
          {item.submitted_at && <span>· Filed <b>{new Date(item.submitted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</b></span>}
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
    if (!selected || reason.trim().length < 20) return;
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
            placeholder="State your grounds clearly. What specific claim is wrong, misleading, or unsupported? Minimum 20 characters."
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={4}
          />
          <div className="pr-challenge-form-foot">
            <span className="pr-vote-hint" style={{ flex: 1 }}>
              {reason.length < 20 ? `${20 - reason.length} more characters needed` : 'Ready to sign'}
            </span>
            <button
              className="pr-nominate-btn"
              disabled={reason.trim().length < 20 || submitting}
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
// Renders edge-function heartbeats (chain-indexer, audit-content-hash) and
// any open tamper alerts. Both tables already have public-read RLS, so this
// panel works for any visitor; the data is operationally meaningful but
// non-sensitive. Stale heartbeats and unresolved tamper alerts are visually
// emphasised so an operator can spot a problem at a glance.
function OpsPanel() {
  const { rows: heartbeats, loading: hbLoading } = useHeartbeats();
  const { alerts, loading: alLoading }           = useTamperAlerts(10);

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
    'chain-indexer':      5  * 60_000,
    'audit-content-hash': 36 * 60 * 60_000,
  };
  function isStale(row) {
    if (!row.last_success) return true;
    const thresh = STALE_THRESHOLD_MS[row.function_name] ?? 5 * 60_000;
    return (Date.now() - new Date(row.last_success).getTime()) > thresh;
  }

  return (
    <section style={{ marginBottom: 32 }}>
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
                    background: stale ? 'var(--danger)' : hb.last_status === 'ok' ? 'var(--accent)' : 'var(--warn)',
                  }} />
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink)' }}>
                    {hb.function_name}
                  </span>
                  <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-faint)' }}>
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
                <span style={{ color: 'var(--ink)' }}>{a.evidence?.title || a.evidence_id}</span>
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
        <p className="sub" style={{ margin: '0 0 12px', color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.08em' }}>
          ✓ No open tamper alerts. Content hashes match canonical for every canonized row.
        </p>
      )}
    </section>
  );
}

// ── ChainEventLog — indexed events from the EvidenceConsensus contract ───────
function ChainEventLog() {
  const { events, loading } = useChainEvents(80);
  if (loading) return <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em' }}>LOADING CHAIN LOG…</div>;
  if (events.length === 0) return (
    <div style={{ padding: '60px 20px', textAlign: 'center', border: '1px dashed var(--line-soft)', borderRadius: 'var(--radius-l)' }}>
      <p className="lead" style={{ margin: 0 }}>No indexed events yet. The chain-indexer hasn't run, or the contract has had no activity.</p>
    </div>
  );
  return (
    <div className="pr-log">
      {events.map(ev => {
        const when = ev.occurred_at ? new Date(ev.occurred_at) : null;
        const diffH = when ? Math.floor((Date.now() - when.getTime()) / 3_600_000) : null;
        const timeStr = !when ? `block ${ev.block_number}` : diffH < 1 ? 'Just now' : diffH < 24 ? `${diffH}h ago` : `${Math.floor(diffH / 24)}d ago`;
        return (
          <div key={ev.id} className="pr-log-row">
            <div className="pr-log-time">{timeStr}</div>
            <div className="pr-log-event">
              <span className="pr-log-kind approve">{ev.event_name}</span>{' '}
              {ev.peer_addr && <b>{SHORT(ev.peer_addr)}</b>}{' '}
              {ev.evidence_id && <em>{ev.evidence_id.slice(0, 8)}…</em>}
            </div>
            <div className="pr-log-hash"><span style={{ color: 'var(--ink-faint)' }}>{SHORT(ev.tx_hash)}</span></div>
          </div>
        );
      })}
    </div>
  );
}

// ── ActivityLog — live from Supabase attestations ─────────────────────────────
function ActivityLog() {
  const { log, loading } = useAttestationLog(60);

  if (loading) return <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em' }}>LOADING LOG…</div>;
  if (log.length === 0) return (
    <div style={{ padding: '60px 20px', textAlign: 'center', border: '1px dashed var(--line-soft)', borderRadius: 'var(--radius-l)' }}>
      <p className="lead" style={{ margin: 0 }}>No attestations yet. Be the first to sign.</p>
    </div>
  );

  return (
    <div className="pr-log">
      {log.map((a, i) => {
        const kindMap = { approve: 'approve', reject: 'reject', challenge: 'revoke', defend: 'endorse' };
        const didMap  = { approve: 'approved', reject: 'rejected', challenge: 'challenged', defend: 'defended' };
        const when = new Date(a.created_at);
        const diffH = Math.floor((Date.now() - when.getTime()) / 3_600_000);
        const timeStr = diffH < 1 ? 'Just now' : diffH < 24 ? `${diffH}h ago` : `${Math.floor(diffH / 24)}d ago`;
        return (
          <div key={i} className="pr-log-row">
            <div className="pr-log-time">{timeStr}</div>
            <div className="pr-log-event">
              <span className={`pr-log-kind ${kindMap[a.verdict] || 'endorse'}`}>{a.verdict}</span>{' '}
              <b>{a.peer_handle || SHORT(a.peer_addr)}</b>{' '}
              <em>{didMap[a.verdict] || a.verdict}</em>{' '}
              <span>{a.evidence?.title || a.evidence_id}</span>
            </div>
            <div className="pr-log-hash"><span style={{ color: 'var(--ink-faint)' }}>{SHORT(a.id)}</span></div>
          </div>
        );
      })}
    </div>
  );
}

// ── SignModal ─────────────────────────────────────────────────────────────────
// Actions that require a wallet signature.  Other actions (endorse, motion,
// finalize, mark_lapsed) are confirmed on-chain only and do not produce a
// Supabase attestation, so no off-chain signature is collected.
const SIG_REQUIRED_ACTIONS = new Set([
  'attest_evidence', 'challenge_evidence', 'defend_evidence', 'open_challenge',
]);

function SignModal({ open, payload, onCancel, onSign, danger, signerAddr }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onCancel(); };
    if (open) window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onCancel]);

  if (!open) return null;
  const requiresSig = SIG_REQUIRED_ACTIONS.has(payload?.action);
  // Show the actual EIP-712 payload that MetaMask will sign — not a fake.
  const previewPayload = requiresSig
    ? {
        evidenceId: payload?.subject || '',
        peerAddr:   signerAddr || '',
        phase:      payload?.phase   || (payload?.action === 'open_challenge' ? 'challenge' : 'review'),
        verdict:    payload?.verdict || '',
        note:       payload?.note    || '',
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
        <div className="pr-sign-payload">{JSON.stringify(previewPayload, null, 2)}</div>
        <div className="pr-modal-actions">
          <button className="pr-modal-btn" onClick={onCancel}>Cancel</button>
          <button className={`pr-modal-btn ${danger ? 'danger' : 'primary'}`} onClick={onSign}>
            {requiresSig ? 'Sign →' : 'Confirm →'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── NotAPeerScreen — shown when wallet is connected but not on the registry ───
function NotAPeerScreen({ addr, onDisconnect }) {
  return (
    <main className="pr-connect">
      <div className="pr-connect-grid">
        <div>
          <div className="eyebrow">◇ Access denied · Not a registered peer</div>
          <h1 className="display" style={{ marginTop: 24 }}>
            This wallet is<br /><em>not a peer.</em>
          </h1>
          <p className="lead">
            The peer review panel is restricted to verified peers on the{' '}
            <code style={{ fontFamily: 'var(--mono)', fontSize: '0.85em' }}>EvidenceConsensus</code>{' '}
            contract. Your connected address is not in the registry.
          </p>
          <div className="pr-connect-card">
            <div className="eyebrow" style={{ marginBottom: 14 }}>◇ How to become a peer</div>
            {[
              ['01', 'Get nominated', 'An existing peer files a nomination with your wallet address.'],
              ['02', 'Receive endorsements', 'Active peers must endorse your nomination. Quorum scales with network size (capped at 9).'],
              ['03', 'Access granted', 'Once the endorsement quorum is reached your address is added to the registry.'],
            ].map(([n, title, desc]) => (
              <div key={n} className="pr-connect-row">
                <span className="pr-connect-num">{n}</span>
                <div><b>{title}</b><p>{desc}</p></div>
              </div>
            ))}
            <div style={{ marginTop: 20, padding: '12px 16px', background: 'color-mix(in oklab, var(--bg-elev) 80%, transparent)', borderRadius: 'var(--radius)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.1em', color: 'var(--ink-faint)', wordBreak: 'break-all' }}>
              Connected: {addr}
            </div>
            <button className="pr-mm-btn" onClick={onDisconnect} style={{ marginTop: 16, background: 'transparent', border: '1px solid var(--line)', color: 'var(--ink-soft)' }}>
              Disconnect and try another wallet
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', opacity: 0.4 }}>
            <svg width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.8" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <path d="M4.93 4.93 l14.14 14.14" />
            </svg>
            <p className="mono" style={{ marginTop: 16, fontSize: 10, letterSpacing: '0.2em' }}>NOT REGISTERED</p>
          </div>
        </div>
      </div>
    </main>
  );
}

// ── ConnectScreen ─────────────────────────────────────────────────────────────
// Periodic-table shell config: n=1 → 2e, n=2 → 8e; peers sit on n=3 (outer)
const INNER_SHELLS = [
  { count: 2, duration: 12, orbitTop: '22%', dotSize: 5, color: 'var(--accent)'   }, // n=1 (r3)
  { count: 8, duration: 25, orbitTop: '14%', dotSize: 6, color: 'var(--accent-2)' }, // n=2 (r2)
];

function ConnectScreen({ onConnect, connecting, peerCount, nomineeCount, attestationCount }) {
  const verifiedPeers = []; // Jazzicon orbit — reserved for future on-chain peer fetch
  const electronSize  = Math.max(14, 44 - verifiedPeers.length * 2);
  const ORBIT_DUR     = 50;

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
              <a href="/artefacts/blockchain/whitepaper.pdf" target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: 9, color: 'var(--accent-2)', letterSpacing: '0.18em', textDecoration: 'none', textTransform: 'uppercase' }}>Whitepaper ↗</a>
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
            <button className="pr-mm-btn" onClick={onConnect} disabled={connecting}>
              <MetaMaskFox />
              {connecting ? 'Awaiting signature…' : 'Connect with MetaMask'}
            </button>
            <div className="pr-mm-meta">
              <div className="pr-mm-meta-row">
                <span className="pr-mm-meta-k">Network</span>
                <span className="pr-mm-meta-v">
                  {CONSENSUS_CHAIN_ID === 56 ? 'BNB Smart Chain' : 'BNB Smart Chain Testnet'} · Chain {CONSENSUS_CHAIN_ID}
                </span>
              </div>
              <div className="pr-mm-meta-row">
                <span className="pr-mm-meta-k">Contract</span>
                {CONSENSUS_ADDR ? (
                  <a
                    className="pr-mm-meta-link"
                    href={`${CONSENSUS_CHAIN_ID === 56 ? 'https://bscscan.com' : 'https://testnet.bscscan.com'}/address/${CONSENSUS_ADDR}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {CONSENSUS_ADDR.slice(0, 8)}…{CONSENSUS_ADDR.slice(-6)} ↗
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
            <div className="pr-orbit-ring r1" />
            <div className="pr-orbit-ring r2" />
            <div className="pr-orbit-ring r3" />

            {/* n=1 and n=2 shells: periodic-table electron dots */}
            {INNER_SHELLS.flatMap((shell, si) =>
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

            {/* n=3 shell: verified peers as Jazzicons */}
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

            <div className="pr-orbit-node you">You</div>
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

  const threshold = nomineeThreshold ?? 1;
  const revThresh = revokeThreshold ?? 1;
  const nomLocked = nominationsOpen === false;

  const isValid = nominee.trim().startsWith('0x') && nominee.trim().length === 42;

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
      ) : nominees.length === 0 ? (
        <div style={{ padding: '60px 20px', textAlign: 'center', border: '1px dashed var(--line-soft)', borderRadius: 'var(--radius-l)', marginTop: 28 }}>
          <p className="lead" style={{ margin: 0 }}>No nominees yet. Be the first to nominate a peer.</p>
        </div>
      ) : (
        <div className="pr-peer-list" style={{ marginTop: 28 }}>
          {nominees.map((n, i) => {
            const pct = Math.min(100, ((n.endorsements ?? 0) / threshold) * 100);
            return (
              <div key={n.addr || i} className="pr-peer-card is-pending">
                <Jazzicon addr={n.addr} size={56} />
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

      {/* Verified peers + revocation surface */}
      <section style={{ marginTop: 56 }}>
        <div className="eyebrow" style={{ marginBottom: 14 }}>
          ◇ Verified peers · {peers.length}
        </div>
        {peersLoading ? (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em' }}>
            LOADING PEERS…
          </div>
        ) : peers.length === 0 ? (
          <div style={{ padding: '40px 20px', textAlign: 'center', border: '1px dashed var(--line-soft)', borderRadius: 'var(--radius-l)' }}>
            <p className="lead" style={{ margin: 0 }}>No peers loaded. Is the contract reachable?</p>
          </div>
        ) : (
          <div className="pr-peer-list">
            {peers.map(p => {
              const pct = p.revActive ? Math.min(100, (p.revVotes / revThresh) * 100) : 0;
              return (
                <div key={p.addr} className={`pr-peer-card ${p.revActive ? 'is-revoking' : ''}`}>
                  <Jazzicon addr={p.addr} size={56} ring={p.isMe} />
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
      </section>
    </section>
  );
}

// ── VerifiedPanel — the main workspace for verified peers ────────────────────
function VerifiedPanel({ me, role, peerCount, nomineeThreshold, revokeThreshold, nominationsOpen, seedPhaseK }) {
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

  const { queue,     loading: qLoading }  = usePendingEvidence();
  const { contested, loading: cLoading }  = useContestedEvidence();
  const { items: unchained, refetch: refetchUnchained } = useUnchainedPending();

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

  const reviewCount = me.reviews + Object.keys(myVotes).length + Object.keys(myChallengeVotes).length;

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
          setChainErr(txHash
            ? `Vote confirmed on-chain (${txHash.slice(0, 10)}…) but cache sync failed. Reload to see the latest state.`
            : `Failed to record vote — ${syncErr?.message || 'unknown error'}`);
          return;
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
          setChainErr(txHash
            ? `Vote confirmed on-chain (${txHash.slice(0, 10)}…) but cache sync failed. Reload to see the latest state.`
            : `Failed to record vote — ${syncErr?.message || 'unknown error'}`);
          return;
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
      setChainErr(`Registered on-chain but cache flag not flipped — reload to refresh. (${syncErr?.message || ''})`);
      return;
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
          setChainErr(txHash
            ? `Challenge confirmed on-chain (${txHash.slice(0, 10)}…) but cache sync failed. Reload to see the latest state.`
            : `Failed to record challenge — ${syncErr?.message || 'unknown error'}`);
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
      <IdentityHeader me={me} role={role} pendingCount={queue.filter(e => !myVotes[e.id]).length} reviewCount={reviewCount} />

      <div className="pr-tabs">
        <button className={`pr-tab ${tab === 'queue' ? 'is-active' : ''}`} onClick={() => setTab('queue')}>
          Review queue <span className="count">{queue.length}</span>
        </button>
        <button className={`pr-tab ${tab === 'challenges' ? 'is-active' : ''}`} onClick={() => setTab('challenges')}>
          Challenges <span className="count">{contested.length}</span>
        </button>
        <button className={`pr-tab ${tab === 'peers' ? 'is-active' : ''}`} onClick={() => setTab('peers')}>
          Peer registry
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

      {/* ── Peer registry ── */}
      {tab === 'peers' && (
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
          <ChainEventLog />
        </section>
      )}

      <footer className="pr-footnote">
        <div>
          <b>Genesis bootstrap</b>
          The system starts with a single Genesis peer (quorum 1). As more peers join, thresholds scale up automatically — nominee quorum caps at 9.
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
        onSign={async () => {
          const sign = pendingSign;
          setPendingSign(null);
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

          await sign.onConfirm(sig);
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
    reviews:    0,
    endorsedBy: 0,
    joined:     new Date().toISOString().split('T')[0],
    bio:        '',
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
