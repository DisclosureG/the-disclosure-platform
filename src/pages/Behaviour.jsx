import { useState, useMemo } from 'react';
import { BrandMark } from '../components/Sigil';
import {
  BEHAVIOUR_DOMAINS,
  useBehaviour,
  useDomainCounts,
  useTierCounts,
  STATUS_LABEL,
  submitPendingBehaviour,
} from '../behaviour-data';
import '../styles/interstellar.css';
import '../styles/evidence.css';
import '../styles/behaviour.css';

// ── Small bits ───────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  if (!status || status === 'aligned') return null;
  const map = {
    pending:    { label: 'Pending',    cls: 'ev-badge-contested'  },
    contested:  { label: 'Contested',  cls: 'ev-badge-contested'  },
    deprecated: { label: 'Deprecated', cls: 'ev-badge-deprecated' },
    reaffirmed: { label: 'Reaffirmed', cls: 'ev-badge-reaffirmed' },
    misaligned: { label: 'Misaligned', cls: 'ev-badge-deprecated' },
    lapsed:     { label: 'Lapsed',     cls: 'ev-badge-contested'  },
  };
  const cfg = map[status];
  if (!cfg) return null;
  return <span className={`ev-status-badge ${cfg.cls}`}>{cfg.label}</span>;
}

function DomainGlyph({ n }) {
  const angle = (parseInt(n, 10) / 9) * 360;
  return (
    <svg className="glyph" viewBox="-12 -12 24 24" aria-hidden="true">
      <circle r="10" fill="none" stroke="currentColor" strokeOpacity="0.4" />
      <line x1="-7" y1="0" x2="7" y2="0" stroke="currentColor" strokeOpacity="0.7"
            transform={`rotate(${angle})`} />
      <circle r="1.6" fill="currentColor" />
    </svg>
  );
}

function Nav() {
  const links = [
    { id: 'manifesto',   label: 'Manifesto',   href: '/#manifesto' },
    { id: 'pillars',     label: 'Pillars',     href: '/#pillars' },
    { id: 'book',        label: 'Thesis',      href: '/#book' },
    { id: 'peace',       label: 'Peace',       href: '/#peace' },
    { id: 'evidence',    label: 'Evidence',    href: '/evidence/' },
    { id: 'behaviour',   label: 'Alignment',   href: '#top' },
    { id: 'peer-review', label: 'Peer Review', href: '/peer-review/' },
  ];
  return (
    <nav className="nav">
      <div className="nav-inner">
        <a href="/" className="brand">
          <BrandMark />
          <span className="brand-text">
            Interstellar Psychology
            <small>A Multiverse of Love</small>
          </span>
        </a>
        <div className="nav-links">
          {links.map(l => (
            <a key={l.id} href={l.href} className={l.id === 'behaviour' ? 'is-active' : ''}>
              {l.label}
            </a>
          ))}
        </div>
        <a href="/#book" className="nav-cta">Acquire Book →</a>
      </div>
    </nav>
  );
}

function Hero({ count, tier1Count, tier2Count, tier3Count }) {
  return (
    <header id="top" className="ev-hero container">
      <div className="ev-hero-grid">
        <div>
          <div className="eyebrow">◇ The alignment ledger ◇ Case by case</div>
          <h1 className="ev-display">
            The <em>alignment</em> of<br />
            artificial intelligence.
          </h1>
          <p className="lead">
            A companion archive to the evidence backbone. Every alignment case the network
            judges — a specific model, a specific input, a specific output — is filed here,
            weighted by tier, voted on by verified peers, and recorded so that the work of
            alignment can outlive its participants.
          </p>
          <p className="lead">
            <a href="/artefacts/blockchain/superalignment.pdf" className="mono"
               style={{ color: 'var(--accent-2, currentColor)', textDecoration: 'none' }}>
              Read the whitepaper →
            </a>
          </p>
        </div>
        <aside className="ev-counter">
          <div className="ev-counter-head">
            <span>Live count</span>
            <span className="ev-dot" />
          </div>
          <p className="ev-counter-num">{count}</p>
          <div className="ev-counter-sub">
            <div><b>{tier1Count}</b><span>Tier I</span></div>
            <div><b>{tier2Count}</b><span>Tier II</span></div>
            <div><b>{tier3Count}</b><span>Tier III</span></div>
          </div>
        </aside>
      </div>
      <div className="ev-legend">
        <span><i className="ev-tier-dot t1" /> Tier I — Reproducible eval</span>
        <span><i className="ev-tier-dot t2" /> Tier II — Institutional audit</span>
        <span><i className="ev-tier-dot t3" /> Tier III — First-person report</span>
      </div>
    </header>
  );
}

function Controls({ q, setQ, domain, setDomain, tier, setTier, sort, setSort, onSubmit, counts }) {
  const domainChips = [
    { id: 'all', label: 'All domains' },
    ...BEHAVIOUR_DOMAINS.map(d => ({ id: d.id, label: d.title, count: counts.domain[d.id] ?? 0 })),
  ];
  const tierChips = [
    { id: 'all', label: 'All tiers' },
    { id: 1,   label: 'Tier I' },
    { id: 2,   label: 'Tier II' },
    { id: 3,   label: 'Tier III' },
  ];
  return (
    <div className="ev-controls">
      <div className="ev-controls-inner">
        <div className="ev-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="SEARCH ALIGNMENT…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        <div className="ev-chip-row" role="tablist" aria-label="Filter by domain">
          {domainChips.map(d => (
            <button key={d.id} className={`ev-chip ${domain === d.id ? 'is-active' : ''}`} onClick={() => setDomain(d.id)}>
              {d.label}
              {d.count !== undefined && <span className="count">{d.count}</span>}
            </button>
          ))}
        </div>

        <div className="ev-chip-row" role="tablist" aria-label="Filter by tier">
          {tierChips.map(t => (
            <button key={t.id} className={`ev-chip ${tier === t.id ? 'is-active' : ''}`} onClick={() => setTier(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="ev-sort-wrap">
          <span>Sort</span>
          <select className="ev-sort" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="domain">By domain</option>
            <option value="tier">By tier</option>
            <option value="recent">Most recent</option>
            <option value="title">Title A–Z</option>
          </select>
        </div>

        <button className="ev-submit-btn" onClick={onSubmit}>
          <span className="plus">+</span> File case
        </button>
      </div>
    </div>
  );
}

function BhCard({ b, onOpen }) {
  const tierLabel = b.tier === 1 ? 'TI' : b.tier === 2 ? 'TII' : 'TIII';
  const isMisaligned = b.status === 'misaligned' || b.status === 'deprecated';
  return (
    <button
      id={`bh-${b.id}`}
      className={`ev-card${isMisaligned ? ' is-deprecated' : b.status === 'contested' ? ' is-contested' : ''}`}
      onClick={() => onOpen(b)}
    >
      <div className="ev-card-top">
        <span className="ev-type bh-domain-chip" data-domain={b.domain}>{b.domainTitle}</span>
        <span className="ev-tier" data-tier={b.tier}>
          <span className="bar"><i /><i /><i /></span>
          {tierLabel}
        </span>
        <StatusBadge status={b.status} />
      </div>
      <h3 className="ev-card-title">{b.title}</h3>
      <p className="ev-card-src">
        <span>{b.model_name}</span>
        {b.model_version && <><span> · </span><span className="year">{b.model_version}</span></>}
      </p>
      {b.summary && <p className="ev-card-excerpt">{b.summary}</p>}
      <div className="ev-card-foot">
        <div className="ev-card-tags">
          <span>#{b.domainSlug}</span>
          <span>#{STATUS_LABEL[b.status] || b.status}</span>
        </div>
        <span className="ev-card-arrow">Open →</span>
      </div>
    </button>
  );
}

function DomainSection({ domain, items, onOpen }) {
  if (items.length === 0) return null;
  return (
    <section id={domain.slug} className="ev-pillar-section">
      <div className="ev-pillar-head">
        <div className="ev-pillar-num">
          <DomainGlyph n={domain.n} />
          <span>DOMAIN {domain.n} / 09</span>
        </div>
        <div>
          <div className="ev-pillar-tag">{domain.tag}</div>
          <h2 className="ev-pillar-title">{domain.title}</h2>
          <p className="ev-pillar-blurb">{domain.blurb}</p>
        </div>
        <div className="ev-pillar-meta">
          <b>{items.length}</b>
          records
        </div>
      </div>
      <div className="ev-grid">
        {items.map(b => <BhCard key={b.id} b={b} onOpen={onOpen} />)}
      </div>
    </section>
  );
}

// ── Detail modal ─────────────────────────────────────────────────────────────

function JsonBlock({ value, label }) {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <div className="ev-modal-section">
      <h4>{label}</h4>
      <pre style={{
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        background: 'rgba(255,255,255,0.04)',
        padding: '0.75rem 1rem', borderRadius: 6,
        fontFamily: 'JetBrains Mono, monospace', fontSize: 13, lineHeight: 1.5,
        maxHeight: 320, overflow: 'auto',
      }}>{str}</pre>
    </div>
  );
}

function DetailModal({ b, onClose }) {
  if (!b) return null;
  return (
    <div className="ev-modal-backdrop is-open" onClick={onClose}>
      <div className="ev-modal" onClick={(e) => e.stopPropagation()}>
        <button className="ev-modal-close" onClick={onClose}>×</button>
        <div className="ev-modal-top">
          <span className="ev-type bh-domain-chip" data-domain={b.domain}>{b.domainTitle}</span>
          <span className="ev-tier" data-tier={b.tier}>
            <span className="bar"><i /><i /><i /></span>
            {b.tier === 1 ? 'Tier I' : b.tier === 2 ? 'Tier II' : 'Tier III'}
          </span>
          <StatusBadge status={b.status} />
        </div>
        <h2 className="ev-modal-title">{b.title}</h2>
        <p className="ev-modal-src">
          <strong>{b.model_name}</strong>
          {b.model_version && <span> · {b.model_version}</span>}
        </p>
        {b.summary && <p className="ev-modal-body">{b.summary}</p>}

        <JsonBlock label="Input"  value={b.input_payload} />
        <JsonBlock label="Output" value={b.output_payload} />
        {(b.seed || b.sampling_params) && (
          <JsonBlock label="Sampling" value={{ seed: b.seed, ...(b.sampling_params ?? {}) }} />
        )}

        {b.reproducer_url && (
          <div className="ev-modal-section">
            <h4>Reproducer</h4>
            <p style={{ wordBreak: 'break-all' }}>
              <a href={b.reproducer_url} target="_blank" rel="noopener noreferrer"
                 style={{ color: 'var(--accent-2, currentColor)' }}>
                {b.reproducer_url}
              </a>
            </p>
          </div>
        )}

        {(b.model_hash || b.input_hash || b.output_hash) && (
          <div className="ev-modal-section">
            <h4>On-chain hashes</h4>
            <div className="mono" style={{ fontSize: 11, opacity: 0.7, lineHeight: 1.7 }}>
              {b.model_hash  && <div>model:  {b.model_hash}</div>}
              {b.input_hash  && <div>input:  {b.input_hash}</div>}
              {b.output_hash && <div>output: {b.output_hash}</div>}
            </div>
          </div>
        )}

        {b.challenge_reason && (
          <div className="ev-modal-section">
            <h4>Challenge grounds</h4>
            <p>{b.challenge_reason}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Submit modal ─────────────────────────────────────────────────────────────

function SubmitModal({ onClose, onSubmitted }) {
  const [form, setForm] = useState({
    title: '', summary: '', domain: 1, tier: 2,
    model_name: '', model_version: '',
    input_payload: '', output_payload: '',
    seed: '', sampling_params: '',
    reproducer_url: '',
  });
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  function parseJson(s, label) {
    if (!s || !s.trim()) return null;
    try { return JSON.parse(s); }
    catch { throw new Error(`${label}: not valid JSON`); }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const payload = {
        title:           form.title.trim(),
        summary:         form.summary.trim() || null,
        domain:          Number(form.domain),
        tier:            Number(form.tier),
        model_name:      form.model_name.trim(),
        model_version:   form.model_version.trim() || null,
        input_payload:   parseJson(form.input_payload, 'Input'),
        output_payload:  parseJson(form.output_payload, 'Output'),
        seed:            form.seed.trim() || null,
        sampling_params: parseJson(form.sampling_params, 'Sampling params'),
        reproducer_url:  form.reproducer_url.trim() || null,
      };
      if (!payload.title)      throw new Error('Title is required');
      if (!payload.model_name) throw new Error('Model name is required');
      await submitPendingBehaviour(payload);
      onSubmitted?.();
      onClose();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ev-modal-backdrop is-open" onClick={onClose}>
      <div className="ev-modal" onClick={(e) => e.stopPropagation()}>
        <button className="ev-modal-close" onClick={onClose}>×</button>
        <h2 className="ev-modal-title">File an alignment case for review</h2>
        <p className="ev-modal-body" style={{ fontSize: 14, opacity: 0.8 }}>
          Anyone can file a pending case. A verified peer must later register
          it on-chain before the network can vote. Hashes are produced from the
          input/output payloads at registration time.
        </p>
        <form onSubmit={handleSubmit} className="ev-form">
          <label className="ev-form-row">
            <span>Title</span>
            <input type="text" value={form.title} onChange={set('title')} required />
          </label>

          <label className="ev-form-row">
            <span>Summary</span>
            <textarea rows={2} value={form.summary} onChange={set('summary')} />
          </label>

          <div className="ev-form-row-double">
            <label className="ev-form-row">
              <span>Domain</span>
              <select value={form.domain} onChange={set('domain')}>
                {BEHAVIOUR_DOMAINS.map(d => <option key={d.id} value={d.id}>{d.n} — {d.title}</option>)}
              </select>
            </label>

            <label className="ev-form-row">
              <span>Tier</span>
              <select value={form.tier} onChange={set('tier')}>
                <option value={1}>I — Reproducible eval</option>
                <option value={2}>II — Institutional audit</option>
                <option value={3}>III — First-person report</option>
              </select>
            </label>
          </div>

          <div className="ev-form-row-double">
            <label className="ev-form-row">
              <span>Model name</span>
              <input type="text" value={form.model_name} onChange={set('model_name')} required />
            </label>

            <label className="ev-form-row">
              <span>Model version</span>
              <input type="text" value={form.model_version} onChange={set('model_version')} />
            </label>
          </div>

          <label className="ev-form-row">
            <span>Input payload (JSON)</span>
            <textarea rows={4} value={form.input_payload} onChange={set('input_payload')}
                      placeholder='{"prompt": "...", "tools": [], "context": "..."}' />
          </label>

          <label className="ev-form-row">
            <span>Output payload (JSON)</span>
            <textarea rows={4} value={form.output_payload} onChange={set('output_payload')}
                      placeholder='{"response": "...", "tool_calls": []}' />
          </label>

          <div className="ev-form-row-double">
            <label className="ev-form-row">
              <span>Seed</span>
              <input type="text" value={form.seed} onChange={set('seed')} />
            </label>
            <label className="ev-form-row">
              <span>Sampling params (JSON)</span>
              <input type="text" value={form.sampling_params} onChange={set('sampling_params')}
                     placeholder='{"temperature": 0, "top_p": 1}' />
            </label>
          </div>

          <label className="ev-form-row">
            <span>Reproducer URL {form.tier === 1 || form.tier === '1' ? '(expected for Tier I)' : '(optional)'}</span>
            <input type="url" value={form.reproducer_url} onChange={set('reproducer_url')}
                   placeholder="https://github.com/… or HuggingFace Space / Zenodo DOI" />
          </label>

          {error && <p className="ev-form-error">{error}</p>}

          <div className="ev-form-actions">
            <button type="button" className="ev-btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="ev-form-submit" disabled={busy}>
              {busy ? 'Filing…' : 'File for review'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

function matchesSearch(b, q) {
  if (!q) return true;
  const s = q.toLowerCase();
  return (
    (b.title          || '').toLowerCase().includes(s) ||
    (b.summary        || '').toLowerCase().includes(s) ||
    (b.model_name     || '').toLowerCase().includes(s) ||
    (b.model_version  || '').toLowerCase().includes(s) ||
    (b.domainTitle    || '').toLowerCase().includes(s)
  );
}

export default function Behaviour() {
  const { rows, loading, refresh } = useBehaviour();
  const [q, setQ]               = useState('');
  const [domain, setDomain]     = useState('all');
  const [tier, setTier]         = useState('all');
  const [sort, setSort]         = useState('domain');
  const [active, setActive]     = useState(null);
  const [submitOpen, setSubmit] = useState(false);

  const visible = useMemo(() => rows.filter(b => {
    if (domain !== 'all' && b.domain !== domain) return false;
    if (tier   !== 'all' && b.tier   !== tier)   return false;
    return matchesSearch(b, q);
  }), [rows, q, domain, tier]);

  const sorted = useMemo(() => {
    const arr = [...visible];
    if (sort === 'tier')   arr.sort((a, b) => a.tier - b.tier || (a.title || '').localeCompare(b.title || ''));
    if (sort === 'title')  arr.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    if (sort === 'recent') arr.sort((a, b) => new Date(b.submitted_at || 0) - new Date(a.submitted_at || 0));
    return arr;
  }, [visible, sort]);

  const domainCounts = useDomainCounts(rows);
  const tierCounts   = useTierCounts(rows);

  return (
    <div className="ev-shell">
      <Nav />
      <main className="container">
        <Hero
          count={rows.length}
          tier1Count={tierCounts[1] ?? 0}
          tier2Count={tierCounts[2] ?? 0}
          tier3Count={tierCounts[3] ?? 0}
        />
        <Controls
          q={q} setQ={setQ}
          domain={domain} setDomain={setDomain}
          tier={tier} setTier={setTier}
          sort={sort} setSort={setSort}
          onSubmit={() => setSubmit(true)}
          counts={{ domain: domainCounts }}
        />

        {loading && <p className="ev-loading">Loading the alignment ledger…</p>}

        {sort === 'domain' ? (
          BEHAVIOUR_DOMAINS.map(d => (
            <DomainSection
              key={d.id}
              domain={d}
              items={sorted.filter(b => b.domain === d.id)}
              onOpen={setActive}
            />
          ))
        ) : (
          <div className="ev-grid container">
            {sorted.map(b => <BhCard key={b.id} b={b} onOpen={setActive} />)}
          </div>
        )}

        {!loading && sorted.length === 0 && (
          <p className="ev-empty">No alignment records match the current filters.</p>
        )}
      </main>

      <DetailModal b={active} onClose={() => setActive(null)} />
      {submitOpen && (
        <SubmitModal
          onClose={() => setSubmit(false)}
          onSubmitted={refresh}
        />
      )}
    </div>
  );
}
