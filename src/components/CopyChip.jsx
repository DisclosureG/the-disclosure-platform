import { useState } from 'react';

// Icon-only copy button. Drop in next to any displayed identifier; calls
// stopPropagation so it can safely sit inside a clickable card or row.
// Styling uses .copy-chip (interstellar.css) + .copy-chip-icon modifier.
export default function CopyChip({ value, label = 'id' }) {
  const [copied, setCopied] = useState(false);
  if (value == null || value === '') return null;
  return (
    <button
      type="button"
      className={`copy-chip copy-chip-icon ${copied ? 'is-copied' : ''}`}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      title={copied ? 'Copied' : `Copy ${label}`}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(String(value));
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {}
      }}
    >
      <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
        {copied ? (
          <path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
        ) : (
          <g fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="9" y="9" width="11" height="11" rx="2"/>
            <path d="M5 15V5a1 1 0 0 1 1-1h10"/>
          </g>
        )}
      </svg>
    </button>
  );
}
