import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { verifyTypedData } from 'ethers';
import { ATTESTATION_DOMAIN, ATTESTATION_TYPES, VOTE_TYPES, CONSENSUS_CHAIN_ID } from '../lib/wallet-constants';
import { recoverAttestationSigner, computeContentHash } from '../lib/wallet';

const explorerBase = CONSENSUS_CHAIN_ID === 56 ? 'https://bscscan.com' : 'https://testnet.bscscan.com';
const SHORT = (a) => (a ? `${a.slice(0, 10)}…${a.slice(-8)}` : '');

// Most peer acts are authorised by an EIP-712 *Vote* recovered on-chain:
// review (phase 0), challenge (phase 1), and now taxonomy ENDORSE (phase 2, whose
// Vote signs the NODE id). Taxonomy REJECT (and the dev-mode endorse fallback)
// stay off-chain *Attestation*-typed. So the proof modal recovers a Vote when the
// row carries the Vote-digest fields and an Attestation otherwise.

// The Vote message a row commits to, or null when it's an Attestation row (or a
// vote row missing its digest fields). review/challenge sign the binding hash;
// taxonomy endorse signs the node id (node_hash).
function voteMessage(a) {
  const round    = a.round ?? null;
  const noteHash  = a.note_hash ?? a.noteHash ?? null;
  if (round == null || !noteHash) return null;
  if (a.phase === 'review' || a.phase === 'challenge') {
    const bindingId = a.binding_hash ?? a.bindingHash ?? null;
    if (!bindingId) return null;
    // verdict → support: approve/challenge = true, reject/defend = false.
    const support = a.verdict === 'approve' || a.verdict === 'challenge';
    const phase   = a.phase === 'challenge' ? 1 : 0;
    return { bindingId, phase, support, round: Number(round), noteHash };
  }
  if (a.phase === 'taxonomy' && a.verdict === 'endorse') {
    const bindingId = a.node_hash ?? a.nodeHash ?? null;
    if (!bindingId) return null;          // dev-mode endorse → Attestation fallback
    return { bindingId, phase: 2, support: true, round: Number(round), noteHash };
  }
  // Node/owner governance: retire (phase 3) + force-renounce (phase 4). Both sign
  // the node id / sentinel in node_hash, support = true.
  if (a.phase === 'retire' || a.phase === 'renounce') {
    const bindingId = a.node_hash ?? a.nodeHash ?? null;
    if (!bindingId) return null;
    return { bindingId, phase: a.phase === 'renounce' ? 4 : 3, support: true, round: Number(round), noteHash };
  }
  return null;
}

// Whether this row's signature can be recovered client-side. review/challenge are
// ONLY recoverable as a Vote (they need the digest fields); taxonomy endorse is a
// Vote when node_hash/round/note_hash are present, else an Attestation; taxonomy
// reject is always an Attestation. When a vote row lacks its digest fields we
// show the chain-only proof (tx) instead of a recovery that can't succeed.
function canRecoverRow(a) {
  if (!a?.eip712_sig) return false;
  // Vote-only rows are recoverable solely via their Vote digest fields.
  if (['review', 'challenge', 'retire', 'renounce'].includes(a.phase)) return !!voteMessage(a);
  return true; // taxonomy endorse (Vote or Attestation) / reject (Attestation)
}

// Reconstruct the exact EIP-712 Attestation message that was signed (taxonomy
// phase). Field order/values must match signAttestation() in
// wallet-constants.js — `note` is the empty string (not null) when no note was
// attached, and the address type is case-insensitive so the stored lowercased
// peer_addr recovers identically.
function buildMessage(a) {
  return {
    evidenceId: String(a.evidence_id ?? ''),
    topicId:    String(a.topic_id ?? ''),
    peerAddr:   a.peer_addr,
    phase:      String(a.phase ?? ''),
    verdict:    String(a.verdict ?? ''),
    note:       String(a.note ?? ''),
  };
}

export function CopyButton({ text, label = 'Copy payload' }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      className={`av-copy ${copied ? 'is-copied' : ''}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {}
      }}
    >
      <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
        {copied
          ? <path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          : <g fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></g>}
      </svg>
      {copied ? 'Copied' : label}
    </button>
  );
}

// One numbered proof in the verification ladder. `state` drives the accent of
// the step index + left rail (idle/ok/bad/na); `chip` is the short status word.
export function ProofStep({ n, title, proves, state = 'idle', chip, children }) {
  return (
    <section className={`av-step is-${state}`}>
      <div className="av-step-head">
        <span className="av-step-n">{n}</span>
        <div className="av-step-heads">
          <h4 className="av-step-title">{title}</h4>
          <p className="av-step-proves">{proves}</p>
        </div>
        {chip && <span className={`av-chip is-${state}`}>{chip}</span>}
      </div>
      <div className="av-step-body">{children}</div>
    </section>
  );
}

// Step 3 body. The vote signature covers the evidence id; the evidence's
// `content_hash` (committed on-chain at submission) binds the actual content —
// title, source, year, excerpt, SOURCE LINK and tier. Recomputing that hash from
// the displayed fields and matching it to the stored hash proves the source link
// shown is the exact one bound to this evidence on-chain. Reports its result up
// so the step header can show the pass/fail rail.
function ContentProofBody({ a, onStatus }) {
  const [status, setStatus] = useState('idle'); // idle → loading → ok | bad | error
  const [computed, setComputed] = useState('');
  const [error, setError] = useState('');

  const onchainHash = a.content_hash || '';
  const content = {
    title:   a.evidence_title,
    source:  a.evidence_source,
    year:    a.evidence_year,
    excerpt: a.evidence_excerpt,
    link:    a.evidence_link,
    tier:    a.evidence_tier,
  };

  useEffect(() => { onStatus?.(status); }, [status, onStatus]);

  const verify = async () => {
    setStatus('loading');
    setError('');
    try {
      const h = await computeContentHash(content);
      setComputed(h);
      setStatus(h.toLowerCase() === onchainHash.toLowerCase() ? 'ok' : 'bad');
    } catch (e) {
      setError(e?.message || 'Hash computation failed');
      setStatus('error');
    }
  };

  return (
    <>
      <div className="av-kv">
        <div className="av-row"><span className="k">Evidence</span><span className="v">{a.evidence_title || '—'}</span></div>
        {(a.evidence_source || a.evidence_year) && (
          <div className="av-row"><span className="k">Source</span><span className="v">{[a.evidence_source, a.evidence_year].filter(Boolean).join(' · ')}</span></div>
        )}
        <div className="av-row">
          <span className="k">Source link</span>
          <span className="v">
            {a.evidence_link
              ? <a className="av-srclink" href={a.evidence_link} target="_blank" rel="noopener noreferrer">{a.evidence_link} <span aria-hidden="true">↗</span></a>
              : <em>No source link on this evidence</em>}
          </span>
        </div>
      </div>

      {onchainHash ? (
        <>
          <div className="av-kv">
            <div className="av-row"><span className="k">On-chain hash</span><span className="v mono">{onchainHash}</span></div>
            {(status === 'ok' || status === 'bad') && (
              <div className="av-row"><span className="k">Recomputed</span><span className="v mono">{computed}</span></div>
            )}
          </div>
          <div className="av-verify">
            <button
              type="button"
              className={`av-btn ${status === 'ok' ? 'is-ok' : status === 'bad' || status === 'error' ? 'is-bad' : ''}`}
              onClick={verify}
              disabled={status === 'loading'}
            >
              {status === 'loading' ? 'Hashing…'
                : status === 'ok' ? 'Content hash matches ✓'
                : status === 'bad' ? 'Hash mismatch ✗'
                : status === 'error' ? 'Computation failed'
                : 'Recompute the content hash'}
            </button>
            {status === 'error' && <p className="av-err">{error}</p>}
          </div>
          <p className={`av-verdict ${status === 'ok' ? 'is-ok' : status === 'bad' ? 'is-bad' : ''}`}>
            {status === 'ok'
              ? 'The source link and content hash to the commitment registered on-chain — the link is provably the one bound to this evidence.'
              : status === 'bad'
              ? 'The recomputed hash does NOT match the on-chain commitment. The source/content shown may have been altered — do not trust it.'
              : 'Recompute the keccak256 hash of the content above in your browser and confirm it equals the on-chain commitment.'}
          </p>
        </>
      ) : (
        <p className="av-step-note">No on-chain content hash is recorded for this evidence yet, so the source link is shown but not yet cryptographically bound.</p>
      )}

      {a.submission_tx_hash && (
        <a className="av-tx" href={`${explorerBase}/tx/${a.submission_tx_hash}`} target="_blank" rel="noopener noreferrer">
          View the evidence submission transaction <span className="mono">{SHORT(a.submission_tx_hash)}</span> <span aria-hidden="true">↗</span>
        </a>
      )}
    </>
  );
}

function VerifierModal({ a, onClose, handle }) {
  const [status, setStatus] = useState('idle');   // step 1 recovery
  const [recovered, setRecovered] = useState(null);
  const [error, setError] = useState('');
  const [contentStatus, setContentStatus] = useState('idle'); // step 3

  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rawSig = a.eip712_sig || '';
  const vote = voteMessage(a);
  const canRecoverVote = !!vote;
  const canRecover = canRecoverRow(a);
  const sig = canRecover ? rawSig : '';

  const message = canRecoverVote ? vote : buildMessage(a);
  const payloadJson = sig
    ? JSON.stringify(
        canRecoverVote
          ? { domain: ATTESTATION_DOMAIN, types: VOTE_TYPES, primaryType: 'Vote', message, signature: sig }
          : { domain: ATTESTATION_DOMAIN, types: ATTESTATION_TYPES, primaryType: 'Attestation', message, signature: sig },
        null, 2,
      )
    : '';

  const verify = async () => {
    setStatus('loading');
    setError('');
    try {
      const addr = canRecoverVote
        ? verifyTypedData(ATTESTATION_DOMAIN, VOTE_TYPES, message, sig)
        : await recoverAttestationSigner({ message, signature: sig });
      setRecovered(addr);
      setStatus(addr.toLowerCase() === String(a.peer_addr).toLowerCase() ? 'ok' : 'bad');
    } catch (e) {
      setError(e?.message || 'Recovery failed');
      setStatus('error');
    }
  };

  // Per-step rail state + status chip.
  const authState = !sig ? 'na' : status === 'ok' ? 'ok' : status === 'bad' ? 'bad' : 'idle';
  const authChip  = !sig ? 'Not archived' : status === 'ok' ? 'Authentic ✓' : status === 'bad' ? 'Mismatch ✗' : null;

  const txState = a.tx_hash ? 'idle' : 'na';
  const txChip  = a.tx_hash ? 'On-chain' : 'No tx';

  const contentState = !a.content_hash ? 'na'
    : contentStatus === 'ok' ? 'ok'
    : contentStatus === 'bad' ? 'bad'
    : 'idle';
  const contentChip = !a.content_hash ? 'Unbound'
    : contentStatus === 'ok' ? 'Bound ✓'
    : contentStatus === 'bad' ? 'Altered ✗'
    : null;

  return createPortal(
    <div className="av-backdrop is-open" onClick={onClose}>
      <div className="av-modal" onClick={(e) => e.stopPropagation()}>
        <button className="av-close" onClick={onClose} aria-label="Close">×</button>

        <span className="av-eyebrow">Independent verification</span>
        <h3 className="av-title">Prove this vote yourself</h3>
        <p className="av-lead">
          This vote stands on three independent proofs — <b>who</b> cast it, <b>that</b> it was
          recorded on-chain, and <b>what</b> it was cast on. Each one re-checks in your own
          browser, with no server in the loop — you never have to trust this page. Work through
          the steps.
        </p>

        <div className="av-steps">

          {/* STEP 1 — Authorship */}
          <ProofStep
            n={1}
            title="Who signed it"
            proves="That the named peer — not the platform — authored this exact verdict and note."
            state={authState}
            chip={authChip}
          >
            {sig ? (
              <>
                <div className="av-verify">
                  <button
                    type="button"
                    className={`av-btn ${status === 'ok' ? 'is-ok' : status === 'bad' || status === 'error' ? 'is-bad' : ''}`}
                    onClick={verify}
                    disabled={status === 'loading'}
                  >
                    {status === 'loading' ? 'Recovering…'
                      : status === 'ok' ? 'Signature authentic ✓'
                      : status === 'bad' ? 'Signer mismatch ✗'
                      : status === 'error' ? 'Verification failed'
                      : 'Recover the signer'}
                  </button>
                  {status === 'error' && <p className="av-err">{error}</p>}
                </div>

                {(status === 'ok' || status === 'bad') && (
                  <div className={`av-result ${status === 'ok' ? 'is-ok' : 'is-bad'}`}>
                    <div className="av-row"><span className="k">Recovered signer</span><span className="v mono">{recovered}</span></div>
                    <div className="av-row"><span className="k">Claimed peer</span><span className="v mono">{a.peer_addr}{(handle || a.peer_handle) ? ` · ${handle || a.peer_handle}` : ''}</span></div>
                    {status === 'ok' && (
                      <>
                        <div className="av-row"><span className="k">Signed verdict</span><span className="v mono">{a.verdict || '—'}</span></div>
                        <div className="av-row">
                          <span className="k">Signed note</span>
                          <span className="v av-note-val">{a.note ? a.note : <em>No note attached</em>}</span>
                        </div>
                      </>
                    )}
                    <p className="av-verdict">
                      {status === 'ok'
                        ? 'The recovered address equals the claimed peer — and the verdict and note above are the exact values that signature covers. Change either and recovery returns a different address.'
                        : 'The recovered address does NOT match the claimed peer. Do not trust this attestation.'}
                    </p>
                  </div>
                )}

                <details className="av-adv">
                  <summary>Verify in another tool</summary>
                  <div className="av-payload">
                    <div className="av-payload-head">
                      <span className="av-label">Signed payload</span>
                      <CopyButton text={payloadJson} />
                    </div>
                    <pre className="av-pre">{payloadJson}</pre>
                    <p className="av-hint">
                      Paste into any EIP-712 tool (e.g. ethers <code>verifyTypedData</code>) to
                      recover the signer without trusting this page.
                    </p>
                  </div>
                </details>
              </>
            ) : (
              <p className="av-step-note">
                No off-chain signature is archived for this vote — the voter likely lost
                connection before it was saved, and the chain doesn't store the signature itself.
                That doesn't weaken the vote: <b>Step 2</b> proves it was cast on-chain, where it
                can't be forged or altered.
              </p>
            )}
          </ProofStep>

          {/* STEP 2 — On-chain record */}
          <ProofStep
            n={2}
            title="That it was cast"
            proves="That the vote was actually submitted and mined on BNB Smart Chain — readable by anyone from the public ledger."
            state={txState}
            chip={txChip}
          >
            {a.tx_hash ? (
              <>
                <p className="av-step-note">
                  The transaction below is the vote being cast on-chain. Open it in the block
                  explorer to confirm it was mined and emitted by the consensus contract.
                </p>
                <a className="av-tx" href={`${explorerBase}/tx/${a.tx_hash}`} target="_blank" rel="noopener noreferrer">
                  View the vote transaction <span className="mono">{SHORT(a.tx_hash)}</span> <span aria-hidden="true">↗</span>
                </a>
              </>
            ) : (
              <p className="av-step-note">No transaction hash is recorded on this row.</p>
            )}
          </ProofStep>

          {/* STEP 3 — Evidence + source integrity */}
          <ProofStep
            n={3}
            title="What it was cast on"
            proves="That the source link and content shown are exactly what was committed on-chain for this evidence."
            state={contentState}
            chip={contentChip}
          >
            <ContentProofBody a={a} onStatus={setContentStatus} />
          </ProofStep>

        </div>
      </div>
    </div>,
    document.body,
  );
}

// Inline proof control. Clicking opens the stepped verification modal. The badge
// reads "EIP-712 ✓" only when the row is actually recoverable in-browser; a vote
// row whose Vote-digest fields aren't surfaced (or any sig-less gap row) reads
// "On-chain ✓" and leans on the tx proof, never claiming a signature it can't
// replay.
export default function AttestationVerifier({ a, handle }) {
  const [open, setOpen] = useState(false);
  const hasSig = canRecoverRow(a);
  return (
    <>
      <button
        type="button"
        className={`av-trigger ${hasSig ? '' : 'is-chainonly'}`}
        onClick={() => setOpen(true)}
        title={hasSig ? 'Verify the EIP-712 signature yourself' : 'On-chain vote — view the proof'}
      >
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M12 2l7 3v6c0 4.5-3 8.5-7 9-4-.5-7-4.5-7-9V5l7-3z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M9 12l2 2 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span className="sig">{hasSig ? 'EIP-712 ✓' : 'On-chain ✓'}</span>
      </button>
      {open && <VerifierModal a={a} onClose={() => setOpen(false)} handle={handle} />}
    </>
  );
}
