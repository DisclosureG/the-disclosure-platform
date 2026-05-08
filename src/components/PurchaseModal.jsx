import { useState, useEffect } from 'react';

const DOGE_ADDR = "DPr9yusdZ37758AEgFjUU6hfL5UiM2WYeT";
const PEPE_ADDR = "0xed525bd95179D3600C84367521285864f5965A03";
const PRICE_USD = 420.69;

function CopyAddress({ value, label }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {}
  };
  return (
    <div className="wallet-address">
      <code>{value}</code>
      <button className={`copy-btn ${copied ? 'copied' : ''}`} onClick={onCopy} aria-label={`Copy ${label} address`}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export default function PurchaseModal({ open, onClose }) {
  const [tab, setTab] = useState('doge');
  const [prices, setPrices] = useState({ doge: null, pepe: null });
  const [msg, setMsg] = useState('');
  const [zoomed, setZoomed] = useState(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch('https://api.coingecko.com/api/v3/simple/price?ids=dogecoin,pepe&vs_currencies=usd')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setPrices({
          doge: d.dogecoin ? (PRICE_USD / d.dogecoin.usd).toFixed(2) : null,
          pepe: d.pepe ? Math.round(PRICE_USD / d.pepe.usd) : null,
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = (which) => {
    const subject = which === 'doge' ? 'Book payment — DOGE' : 'Book payment — PEPE';
    const body = msg.trim() || 'Transaction Hash:\nDelivery Address:';
    window.location.href = `mailto:neo@interstellar-psychology.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  return (
    <div className={`modal-backdrop ${open ? 'is-open' : ''}`} onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        <div className="eyebrow">Acquire the book</div>
        <h3 className="h3" style={{ marginTop: 8 }}>A Multiverse of Love</h3>
        <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: 8 }}>
          Payable in memetic currencies only. The book chose its own price tags — we are merely scribes.
        </p>

        <div className="modal-tabs" role="tablist">
          <button
            className={`modal-tab ${tab === 'doge' ? 'is-active' : ''}`}
            onClick={() => setTab('doge')}
            role="tab"
          >Dogecoin</button>
          <button
            className={`modal-tab ${tab === 'pepe' ? 'is-active' : ''}`}
            onClick={() => setTab('pepe')}
            role="tab"
          >Pepe</button>
        </div>

        {tab === 'doge' ? (
          <div className="wallet-card">
            <div className="wallet-row">
              <button
                className="wallet-qr"
                onClick={() => setZoomed({ src: '/artefacts/dogewallet.jpg', label: 'Dogecoin wallet', addr: DOGE_ADDR })}
                aria-label="Enlarge Doge wallet QR"
              >
                <img src="/artefacts/dogewallet.jpg" alt="Doge wallet QR" />
              </button>
              <div className="wallet-info">
                <div className="label">Send to wallet</div>
                <div className="amount">
                  ≈ {prices.doge ?? '…'} <small>DOGE</small>
                </div>
                <div className="label" style={{ marginTop: 6 }}>= ${PRICE_USD} USD</div>
              </div>
            </div>
            <CopyAddress value={DOGE_ADDR} label="Doge" />
          </div>
        ) : (
          <div className="wallet-card">
            <div className="wallet-row">
              <button
                className="wallet-qr"
                onClick={() => setZoomed({ src: '/artefacts/pepewallet.jpg', label: 'Pepe wallet', addr: PEPE_ADDR })}
                aria-label="Enlarge Pepe wallet QR"
              >
                <img src="/artefacts/pepewallet.jpg" alt="Pepe wallet QR" />
              </button>
              <div className="wallet-info">
                <div className="label">Send to wallet</div>
                <div className="amount">
                  ≈ {prices.pepe ?? '…'} <small>PEPE</small>
                </div>
                <div className="label" style={{ marginTop: 6 }}>= ${PRICE_USD} USD</div>
              </div>
            </div>
            <CopyAddress value={PEPE_ADDR} label="Pepe" />
          </div>
        )}

        <div className="modal-form">
          <div className="eyebrow" style={{ marginBottom: 6 }}>Confirm payment</div>
          <textarea
            placeholder={'Transaction Hash:\nDelivery Address:'}
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => send(tab)}>
              I sent {tab === 'doge' ? 'DOGE' : 'PEPE'} →
            </button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--ink-faint)', fontFamily: 'var(--mono)', marginTop: 12, letterSpacing: '.08em' }}>
            or email neo@interstellar-psychology.com
          </p>
        </div>
      </div>

      {zoomed && (
        <div className="qr-zoom" onClick={(e) => { e.stopPropagation(); setZoomed(null); }}>
          <div className="qr-zoom-card" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setZoomed(null)} aria-label="Close">×</button>
            <div className="eyebrow" style={{ marginBottom: 14 }}>{zoomed.label}</div>
            <img className="qr-zoom-img" src={zoomed.src} alt={zoomed.label + ' QR'} />
            <div className="qr-zoom-addr">
              <code>{zoomed.addr}</code>
            </div>
            <p className="qr-zoom-hint">Scan with your wallet · or click outside to close</p>
          </div>
        </div>
      )}
    </div>
  );
}
