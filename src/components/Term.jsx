import { useState, useRef, useEffect } from 'react';

// Plain-language-first helper: shows an everyday word with a dotted underline and
// a small ⓘ that reveals the exact technical term on hover / focus / tap. Lets the
// UI lead with accessible language while keeping the "verify it yourself" detail one
// gesture away. Use as <Term plain="approve" tech="cryptographically sign (EIP-712)" />.
export function Term({ plain, tech, children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onEsc = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <span className="term" ref={ref}>
      <button
        type="button"
        className="term-trigger"
        aria-label={`${plain} — what this means`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {children || plain}
        <span className="term-i" aria-hidden="true">i</span>
      </button>
      {open ? (
        <span className="term-pop" role="tooltip">{tech}</span>
      ) : null}
    </span>
  );
}
