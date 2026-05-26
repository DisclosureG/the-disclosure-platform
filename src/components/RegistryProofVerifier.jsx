import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { verifyTypedData, keccak256, toUtf8Bytes, ZeroHash } from 'ethers';
import {
  PEER_GOVERNANCE_DOMAIN, PEER_VOTE_TYPES, PEER_VOTE_KIND,
  ATTESTATION_DOMAIN, ATTESTATION_TYPES, CONSENSUS_CHAIN_ID,
} from '../lib/wallet-constants';
import { recoverAttestationSigner } from '../lib/wallet';
import { ProofStep, CopyButton, DerivationPanel } from './AttestationVerifier';
import { getRegistryDerivation } from '../evidence-data';

// The registry analogue of AttestationVerifier: a per-row proof control for the
// peer-registry vote history. Registry membership votes are authorised by an
// EIP-712 *PeerVote* (PeerGovernance domain) recovered on-chain; the one
// exception is `keep`, an off-chain dissent that has no on-chain call and is
// signed as a core *Attestation* (phase 'revocation'). Lifecycle outcomes
// (verified / lapsed / revoked …) carry no signature — only a tx — so they read
// "On-chain ✓" and lean on the tx proof.

const explorerBase = CONSENSUS_CHAIN_ID === 56 ? 'https://bscscan.com' : 'https://testnet.bscscan.com';
const SHORT = (a) => (a ? `${a.slice(0, 10)}…${a.slice(-8)}` : '');

// registry action → the PeerVote `kind` it was signed under. `keep` is absent: it
// is an Attestation, not a PeerVote (handled separately below).
const REG_VOTE_KIND = {
  nominate: PEER_VOTE_KIND.nominate,
  endorse:  PEER_VOTE_KIND.nominee,
  discard:  PEER_VOTE_KIND.revoke,
  motion:   PEER_VOTE_KIND.revoke,
};

// keccak256(note text), zero hash for an empty note — mirrors noteHashOf() in
// wallet-impl.js so the recomputed noteHash matches the one the signature covers.
const noteHashOf = (note) => {
  const s = String(note ?? '');
  return s.length ? keccak256(toUtf8Bytes(s)) : ZeroHash;
};

// Reconstruct the exact EIP-712 message this row's signature covers, or null when
// the row has no recoverable signature (a sig-less lifecycle outcome, or a vote
// row missing the round/subject needed to rebuild the digest). The signer is the
// row's ACTOR (endorser / voter / nominator / keep voter).
function proofMessage(r) {
  if (!r?.sig || !r.actorAddr) return null;
  if (r.action === 'keep') {
    if (r.round == null || !r.subjectAddr) return null;
    const message = {
      evidenceId: String(r.round),
      topicId:    String(r.subjectAddr).toLowerCase(),
      peerAddr:   r.actorAddr,
      phase:      'revocation',
      verdict:    'keep',
      note:       String(r.note ?? ''),
    };
    return { scheme: 'attestation', domain: ATTESTATION_DOMAIN, types: ATTESTATION_TYPES, primaryType: 'Attestation', message };
  }
  const kind = REG_VOTE_KIND[r.action];
  if (kind == null || r.round == null || !r.subjectAddr) return null;
  const message = {
    subject:  r.subjectAddr,
    kind,
    support:  true,
    round:    Number(r.round),
    noteHash: noteHashOf(r.note),
  };
  return { scheme: 'peervote', domain: PEER_GOVERNANCE_DOMAIN, types: PEER_VOTE_TYPES, primaryType: 'PeerVote', message };
}

function RegistryVerifierModal({ r, actorName, actionLabel, onClose, onLinkback }) {
  const [status, setStatus] = useState('idle');
  const [recovered, setRecovered] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const proof = proofMessage(r);
  const sig = proof ? r.sig : '';
  const payloadJson = proof
    ? JSON.stringify({ domain: proof.domain, types: proof.types, primaryType: proof.primaryType, message: proof.message, signature: r.sig }, null, 2)
    : '';

  // Consensus Network rows = verified / revoked / cancelled. These are the
  // contract's projection of underlying signed registry votes (nominee
  // endorsements / revocation discards / keep dissents), so step 1 swaps the
  // signer-recovery body for a DerivationPanel showing the tally + threshold +
  // a linkback that filters the log to the contributing signatures.
  const descriptor = getRegistryDerivation(r);
  const isConsensus = !!descriptor;

  const verify = async () => {
    setStatus('loading');
    setError('');
    try {
      const addr = proof.scheme === 'peervote'
        ? verifyTypedData(proof.domain, proof.types, proof.message, sig)
        : await recoverAttestationSigner({ message: proof.message, signature: sig });
      setRecovered(addr);
      setStatus(addr.toLowerCase() === String(r.actorAddr).toLowerCase() ? 'ok' : 'bad');
    } catch (e) {
      setError(e?.message || 'Recovery failed');
      setStatus('error');
    }
  };

  const authState = isConsensus ? 'na' : !sig ? 'na' : status === 'ok' ? 'ok' : status === 'bad' ? 'bad' : 'idle';
  const authChip  = isConsensus ? 'Derived' : !sig ? 'Not signed' : status === 'ok' ? 'Authentic ✓' : status === 'bad' ? 'Mismatch ✗' : null;
  const txState = r.txHash ? 'idle' : 'na';
  const txChip  = r.txHash ? 'On-chain' : 'Off-chain';

  return createPortal(
    <div className="av-backdrop is-open" onClick={onClose}>
      <div className="av-modal" onClick={(e) => e.stopPropagation()}>
        <button className="av-close" onClick={onClose} aria-label="Close">×</button>

        <span className="av-eyebrow">Independent verification</span>
        <h3 className="av-title">{isConsensus ? 'How this consensus outcome was derived' : 'Prove this registry vote yourself'}</h3>
        <p className="av-lead">
          {isConsensus ? (
            <>
              The contract emitted this outcome when the underlying signed registry votes crossed
              threshold. <b>Step 1</b> shows the tally + threshold derived from the signed peer
              votes; <b>Step 2</b> shows the on-chain transaction the contract emitted. Each
              contributing peer vote is its own row in this log with an EIP-712 signature you can
              recover in your browser.
            </>
          ) : (
            <>
              This act stands on two independent proofs — <b>who</b> cast it and <b>that</b> it was
              recorded. Each one re-checks in your own browser, with no server in the loop — you never
              have to trust this page.
            </>
          )}
        </p>

        <div className="av-steps">

          {/* STEP 1 — Authorship (signed-peer rows) / Derivation (consensus Network rows) */}
          <ProofStep
            n={1}
            title={isConsensus ? 'How peers got here' : 'Who signed it'}
            proves={isConsensus
              ? 'That the on-chain outcome is the contract\'s projection of the underlying signed peer votes — recountable from the public registry-vote tables.'
              : 'That the named peer — not the platform — authored this exact vote and note.'}
            state={authState}
            chip={authChip}
          >
            {isConsensus ? (
              <DerivationPanel descriptor={descriptor} onLinkback={onLinkback} />
            ) : sig ? (
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
                    <div className="av-row"><span className="k">Claimed peer</span><span className="v mono">{r.actorAddr}{actorName ? ` · ${actorName}` : ''}</span></div>
                    {status === 'ok' && (
                      <>
                        <div className="av-row"><span className="k">Signed act</span><span className="v mono">{actionLabel || r.action}</span></div>
                        <div className="av-row">
                          <span className="k">Signed note</span>
                          <span className="v av-note-val">{r.note ? r.note : <em>No note attached</em>}</span>
                        </div>
                      </>
                    )}
                    <p className="av-verdict">
                      {status === 'ok'
                        ? 'The recovered address equals the claimed peer — and the act and note above are the exact values that signature covers. Change either and recovery returns a different address.'
                        : 'The recovered address does NOT match the claimed peer. Do not trust this vote.'}
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
                This act carries no off-chain signature — it's a lifecycle outcome the contract
                emitted, not a peer's signed vote. <b>Step 2</b> proves it was recorded on-chain,
                where it can't be forged or altered.
              </p>
            )}
          </ProofStep>

          {/* STEP 2 — Recorded */}
          <ProofStep
            n={2}
            title="That it was cast"
            proves="That the act was submitted on BNB Smart Chain — or, for an off-chain dissent, signed and stored with its signature."
            state={txState}
            chip={txChip}
          >
            {r.txHash ? (
              <>
                <p className="av-step-note">
                  The transaction below is this act on-chain. Open it in the block explorer to
                  confirm it was mined and emitted by the governance contract.
                </p>
                <a className="av-tx" href={`${explorerBase}/tx/${r.txHash}`} target="_blank" rel="noopener noreferrer">
                  View the transaction <span className="mono">{SHORT(r.txHash)}</span> <span aria-hidden="true">↗</span>
                </a>
              </>
            ) : (
              <p className="av-step-note">
                This is an off-chain signed dissent (a “keep” vote), which has no on-chain call —
                the chain doesn't store it. Its authenticity rests entirely on the EIP-712
                signature recovered in <b>Step 1</b>.
              </p>
            )}
          </ProofStep>

        </div>
      </div>
    </div>,
    document.body,
  );
}

// Inline proof control for one registry-log row. "EIP-712 ✓" when the row's
// signature is recoverable in-browser; "On-chain ✓" for a sig-less act that still
// has a tx; a plain dash when there's neither.
export default function RegistryProofVerifier({ r, actorName, actionLabel, onLinkback }) {
  const [open, setOpen] = useState(false);
  const recoverable = !!proofMessage(r);
  const isConsensus = !!getRegistryDerivation(r);
  if (!recoverable && !r.txHash) return <span style={{ color: 'var(--ink-faint)' }}>—</span>;
  return (
    <>
      <button
        type="button"
        className={`av-trigger ${isConsensus ? 'is-derived' : recoverable ? '' : 'is-chainonly'}`}
        onClick={() => setOpen(true)}
        title={isConsensus
          ? 'Derived consensus outcome — projection of the signed registry votes (modal shows the tally + the on-chain emission tx)'
          : recoverable ? 'Verify the EIP-712 signature yourself' : 'On-chain act — view the proof'}
      >
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M12 2l7 3v6c0 4.5-3 8.5-7 9-4-.5-7-4.5-7-9V5l7-3z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="M9 12l2 2 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <span className="sig">{isConsensus ? 'Derived ✓' : recoverable ? 'EIP-712 ✓' : 'On-chain ✓'}</span>
      </button>
      {open && <RegistryVerifierModal r={r} actorName={actorName} actionLabel={actionLabel} onClose={() => setOpen(false)} onLinkback={onLinkback} />}
    </>
  );
}
