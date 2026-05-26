import { useState } from 'react';
import { useEvidenceVotes, usePeerHandleMap } from '../evidence-data';
import AttestationVerifier from './AttestationVerifier';
import CopyChip from './CopyChip';

// Taxonomy endorsements ('endorse') are the same act as a review approval, so
// they read as "Approved" (mirrors Home + Peer Review). `verdictClass` maps to
// the colour class defined in evidence.css.
const VERDICT_LABEL = { approve: 'Approved', endorse: 'Approved', reject: 'Rejected', challenge: 'Challenged', defend: 'Defended' };
const verdictClass = (v) => (v === 'endorse' ? 'approve' : v);
const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24); return `${d} d ago`;
}

function WhoVotedRow({ v, handleMap }) {
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

// Shared "Who voted" section — the open, signed peer-vote log for one evidence
// record, rendered inside every evidence peek/preview modal via
// EvidenceDetailBody. Reads the public attestation log so anyone can see who
// voted, how, and verify each EIP-712 signature without a wallet. Renders
// nothing until votes load and only when at least one signed vote exists.
export default function WhoVoted({ evidenceId }) {
  const { votes, loading } = useEvidenceVotes(evidenceId);
  const handleMap = usePeerHandleMap();
  const [open, setOpen] = useState(false);

  if (!evidenceId || loading || votes.length === 0) return null;

  const tally = votes.reduce((m, v) => { const k = verdictClass(v.verdict); m[k] = (m[k] || 0) + 1; return m; }, {});
  const tallyOrder = [['approve', 'Approved'], ['reject', 'Rejected'], ['challenge', 'Challenged'], ['defend', 'Defended']]
    .filter(([k]) => tally[k]);

  return (
    <section className={`ev-detail-votes${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="ev-detail-votes-toggle"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        title={open ? 'Hide who voted' : 'See who voted'}
      >
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1" />
          <circle cx="9" cy="7" r="3" />
          <path d="M22 19v-1a4 4 0 0 0-3-3.87" />
          <path d="M16 4.13A4 4 0 0 1 16 11.87" />
        </svg>
        <span className="ev-detail-votes-toggle-label">Who voted</span>
        <span className="ev-detail-votes-count">{votes.length}</span>
        <span className="ev-detail-votes-caret" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="ev-detail-votes-panel">
          {tallyOrder.length > 0 && (
            <div className="ev-votes-tally">
              {tallyOrder.map(([k, label]) => (
                <span key={k} className={`ev-votes-tally-chip ${k}`}>{tally[k]} {label}</span>
              ))}
            </div>
          )}
          <div className="ev-votes-list">
            <div className="ev-vote-row is-head"><span>When</span><span>Verdict</span><span>Peer</span><span>Note</span><span>Proof</span></div>
            {votes.map(v => <WhoVotedRow key={v.id} v={v} handleMap={handleMap} />)}
          </div>
        </div>
      )}
    </section>
  );
}
