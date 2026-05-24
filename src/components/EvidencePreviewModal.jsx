import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import EvidenceDetailBody from './EvidenceDetailBody';
import CopyChip from './CopyChip';
import '../styles/evidence.css';

// Shared read-only evidence preview — renders the public archive record body
// (EvidenceDetailBody) inside modal chrome with an id footer. Used wherever a
// list links to the full record (Peer Review vote history, home vote feed).
export default function EvidencePreviewModal({ b, onClose, statusLabel = null }) {
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
