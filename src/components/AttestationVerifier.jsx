import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ATTESTATION_DOMAIN, ATTESTATION_TYPES, CONSENSUS_CHAIN_ID } from '../lib/wallet-constants';
import { recoverAttestationSigner } from '../lib/wallet';

const explorerBase = CONSENSUS_CHAIN_ID === 56 ? 'https://bscscan.com' : 'https://testnet.bscscan.com';
const SHORT = (a) => (a ? `${a.slice(0, 10)}…${a.slice(-8)}` : '');

// Reconstruct the exact EIP-712 message that was signed. Field order/values must
// match signAttestation() in wallet-constants.js — `note` is the empty string
// (not null) when no note was attached, and the address type is case-insensitive
// so the stored lowercased peer_addr recovers identically.
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

function CopyButton({ text, label = 'Copy payload' }) {
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

function VerifierModal({ a, onClose, handle }) {
  // status: idle → loading → ok | bad | error
  const [status, setStatus] = useState('idle');
  const [recovered, setRecovered] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sig = a.eip712_sig || '';
  const message = buildMessage(a);
  const payloadJson = JSON.stringify(
    { domain: ATTESTATION_DOMAIN, types: ATTESTATION_TYPES, primaryType: 'Attestation', message, signature: sig },
    null, 2,
  );

  const verify = async () => {
    setStatus('loading');
    setError('');
    try {
      const addr = await recoverAttestationSigner({ message, signature: sig });
      setRecovered(addr);
      setStatus(addr.toLowerCase() === String(a.peer_addr).toLowerCase() ? 'ok' : 'bad');
    } catch (e) {
      setError(e?.message || 'Recovery failed');
      setStatus('error');
    }
  };

  return createPortal(
    <div className="av-backdrop is-open" onClick={onClose}>
      <div className="av-modal" onClick={(e) => e.stopPropagation()}>
        <button className="av-close" onClick={onClose} aria-label="Close">×</button>

        <span className="av-eyebrow">{sig ? 'EIP-712 signature' : 'On-chain vote'}</span>
        <h3 className="av-title">Verify this attestation yourself</h3>
        <p className="av-lead">
          {sig
            ? `This signature proves the named peer — not the platform — authored the vote. Recovery runs entirely in your browser: it recomputes the EIP-712 digest from the message below and recovers the signing address, with no server in the loop. The on-chain transaction is a separate proof that the vote was mined.`
            : `This vote was settled on-chain — the transaction below is the proof it happened, recoverable by anyone from the public ledger.`}
        </p>

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
                  : 'Recover signer in your browser'}
              </button>

              {(status === 'ok' || status === 'bad') && (
                <div className={`av-result ${status === 'ok' ? 'is-ok' : 'is-bad'}`}>
                  <div className="av-row"><span className="k">Recovered signer</span><span className="v mono">{recovered}</span></div>
                  <div className="av-row"><span className="k">Claimed peer</span><span className="v mono">{a.peer_addr}{(handle || a.peer_handle) ? ` · ${handle || a.peer_handle}` : ''}</span></div>
                  {status === 'ok' && (
                    <>
                      <div className="av-row"><span className="k">Signed verdict</span><span className="v mono">{message.verdict || '—'}</span></div>
                      <div className="av-row">
                        <span className="k">Signed note</span>
                        <span className="v av-note-val">{message.note ? message.note : <em>No note attached</em>}</span>
                      </div>
                    </>
                  )}
                  <p className="av-verdict">
                    {status === 'ok'
                      ? 'The recovered address equals the claimed peer — and the verdict and note above are the exact values that signature covers. Change either and recovery would return a different address. The attestation is authentic.'
                      : 'The recovered address does NOT match the claimed peer. Do not trust this attestation.'}
                  </p>
                </div>
              )}
              {status === 'error' && <p className="av-err">{error}</p>}
            </div>

            <div className="av-payload">
              <div className="av-payload-head">
                <span className="av-label">Signed payload · verify independently</span>
                <CopyButton text={payloadJson} />
              </div>
              <pre className="av-pre">{payloadJson}</pre>
              <p className="av-hint">
                Paste this into any EIP-712 tool (e.g. ethers <code>verifyTypedData</code>)
                to recover the signer without trusting this page.
              </p>
            </div>
          </>
        ) : (
          <div className="av-nosig">
            <p className="av-nosig-head">No off-chain signature is archived for this vote.</p>
            <p>
              The EIP-712 signature only ever exists in the voter's browser; it is
              persisted by a follow-up call after the transaction is mined. This
              vote was recovered directly from the chain — its on-chain
              transaction is the proof it happened — but the off-chain signature
              was not captured (the voter likely lost connection before it was
              saved), and the chain does not store it, so it cannot be replayed
              here. The vote still counts: it is recorded and verifiable on-chain.
            </p>
          </div>
        )}

        {a.tx_hash && (
          <a className="av-tx" href={`${explorerBase}/tx/${a.tx_hash}`} target="_blank" rel="noopener noreferrer">
            View the on-chain transaction <span className="mono">{SHORT(a.tx_hash)}</span> <span aria-hidden="true">↗</span>
          </a>
        )}
      </div>
    </div>,
    document.body,
  );
}

// Inline proof control. Clicking opens a modal that recovers the signer
// client-side and surfaces the raw signed payload for independent verification —
// replacing the old badge that only deep-linked to BscScan (which can show the
// transaction but never the EIP-712 signature). When a row has no off-chain
// signature (an indexer-backfilled gap row), the badge reads "On-chain ✓"
// instead so it never claims a signature that isn't archived.
export default function AttestationVerifier({ a, handle }) {
  const [open, setOpen] = useState(false);
  const hasSig = !!a.eip712_sig;
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
