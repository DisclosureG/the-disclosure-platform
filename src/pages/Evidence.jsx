import { useState, useEffect, useMemo } from 'react';
import { BrandMark } from '../components/Sigil';
import { PILLARS, useEvidence } from '../evidence-data';
import { supabase } from '../lib/supabase';
import '../styles/interstellar.css';
import '../styles/evidence.css';

function PillarGlyph({ n }) {
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
    { id: 'manifesto', label: 'Manifesto', href: '/#manifesto' },
    { id: 'pillars',   label: 'Pillars',   href: '/#pillars' },
    { id: 'book',      label: 'Thesis',    href: '/#book' },
    { id: 'peace',     label: 'Peace',     href: '/#peace' },
    { id: 'evidence',  label: 'Evidence',  href: '#top' },
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
            <a key={l.id} href={l.href} className={l.id === 'evidence' ? 'is-active' : ''}>
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
          <div className="eyebrow">◇ The backbone ◇ Pillar by pillar</div>
          <h1 className="ev-display">
            The <em>evidence</em> for a<br />
            Multiverse of love.
          </h1>
          <p className="lead">
            A living archive. Every claim Interstellar Psychology makes is filed here against the
            record that supports it — papers, books, podcasts, declassified files, testimony.
            Organised by pillar, weighted by tier, open to the world for additions.
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
        <span><i className="ev-tier-dot t1" /> Tier I — Peer-reviewed · Declassified</span>
        <span><i className="ev-tier-dot t2" /> Tier II — Documented · Art</span>
        <span><i className="ev-tier-dot t3" /> Tier III — Testimony · First-person</span>
      </div>
    </header>
  );
}

function Controls({ q, setQ, type, setType, tier, setTier, sort, setSort, onSubmit, counts }) {
  const typeChips = ['All', 'Paper', 'Book', 'Podcast', 'Documentary', 'Declassified', 'Testimony', 'Lecture', 'Art', 'Photograph'];
  const tierChips = [
    { id: 'all', label: 'All tiers' },
    { id: '1',   label: 'Tier I' },
    { id: '2',   label: 'Tier II' },
    { id: '3',   label: 'Tier III' },
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
            placeholder="SEARCH EVIDENCE…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        <div className="ev-chip-row" role="tablist" aria-label="Filter by type">
          {typeChips.map(t => (
            <button key={t} className={`ev-chip ${type === t ? 'is-active' : ''}`} onClick={() => setType(t)}>
              {t}
              <span className="count">{counts.type[t] ?? 0}</span>
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
            <option value="pillar">By pillar</option>
            <option value="tier">By tier</option>
            <option value="year-desc">Year — newest</option>
            <option value="year-asc">Year — oldest</option>
            <option value="title">Title A–Z</option>
          </select>
        </div>

        <button className="ev-submit-btn" onClick={onSubmit}>
          <span className="plus">+</span> Submit evidence
        </button>
      </div>
    </div>
  );
}

function EvCard({ e, onOpen }) {
  const tierLabel = e.tier === 1 ? 'TI' : e.tier === 2 ? 'TII' : 'TIII';
  return (
    <button className="ev-card" onClick={() => onOpen(e)}>
      <div className="ev-card-top">
        <span className="ev-type">{e.type}</span>
        <span className="ev-tier" data-tier={e.tier}>
          <span className="bar"><i /><i /><i /></span>
          {tierLabel}
        </span>
      </div>
      <h3 className="ev-card-title">{e.title}</h3>
      <p className="ev-card-src">
        <span>{e.source}</span>
        <span> · </span>
        <span className="year">{e.year}</span>
      </p>
      <p className="ev-card-excerpt">{e.excerpt}</p>
      <div className="ev-card-foot">
        <div className="ev-card-tags">
          {(e.tags || []).slice(0, 3).map(t => <span key={t}>#{t}</span>)}
        </div>
        <span className="ev-card-arrow">Open →</span>
      </div>
    </button>
  );
}

function PillarSection({ pillar, items, onOpen }) {
  return (
    <section id={pillar.id} className="ev-pillar-section">
      <div className="ev-pillar-head">
        <div className="ev-pillar-num">
          <PillarGlyph n={pillar.n} />
          <span>PILLAR {pillar.n} / 09</span>
        </div>
        <div>
          <div className="ev-pillar-tag">{pillar.tag}</div>
          <h2 className="ev-pillar-title">{pillar.title}</h2>
          <p className="ev-pillar-blurb">{pillar.blurb}</p>
        </div>
        <div className="ev-pillar-meta">
          <b>{items.length}</b>
          entries
        </div>
      </div>
      <div className="ev-grid">
        {items.length === 0 ? (
          <div className="ev-empty">No matches in this pillar — clear filters or submit the first one.</div>
        ) : (
          items.map(e => <EvCard key={e.id} e={e} onOpen={onOpen} />)
        )}
      </div>
    </section>
  );
}

function FlatGrid({ items, onOpen }) {
  return (
    <section className="ev-pillar-section">
      <div className="ev-pillar-head">
        <div className="ev-pillar-num">
          <PillarGlyph n="00" />
          <span>FILTERED VIEW</span>
        </div>
        <div>
          <div className="ev-pillar-tag">Sorted across all pillars</div>
          <h2 className="ev-pillar-title">All evidence</h2>
          <p className="ev-pillar-blurb">Switch sort back to "by pillar" to see the structural view.</p>
        </div>
        <div className="ev-pillar-meta">
          <b>{items.length}</b>
          entries
        </div>
      </div>
      <div className="ev-grid">
        {items.length === 0 ? (
          <div className="ev-empty">No matches. Try clearing the filters.</div>
        ) : (
          items.map(e => <EvCard key={e.id} e={e} onOpen={onOpen} />)
        )}
      </div>
    </section>
  );
}

function DetailModal({ e, onClose }) {
  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!e) return null;
  const tierLabel = e.tier === 1 ? 'I' : e.tier === 2 ? 'II' : 'III';
  const tierDesc = e.tier === 1 ? 'I — Peer-reviewed / Declassified' : e.tier === 2 ? 'II — Documented / Institutional' : 'III — Testimony / First-person';
  return (
    <div className="ev-modal-backdrop is-open" onClick={onClose}>
      <div className="ev-modal" onClick={(ev) => ev.stopPropagation()}>
        <button className="ev-modal-close" onClick={onClose} aria-label="Close">×</button>
        <div className="ev-detail-eyebrow">
          <span className="ev-type">{e.type}</span>
          <span className="ev-tier" data-tier={e.tier}>
            <span className="bar"><i /><i /><i /></span>
            Tier {tierLabel}
          </span>
        </div>
        <h3 className="ev-detail-title">{e.title}</h3>
        <p className="ev-detail-src">
          <span>{e.source}</span> · <span className="year">{e.year}</span>
          <span> · Pillar {e.pillarNum} {e.pillarTitle}</span>
        </p>
        <div className="ev-detail-body">
          <p>{e.excerpt}</p>
          {e.body && <p>{e.body}</p>}
          {e.quote && <p className="ev-detail-quote">&ldquo;{e.quote}&rdquo;</p>}
        </div>
        <dl className="ev-detail-meta">
          <dt>Pillar</dt><dd>{e.pillarNum} · {e.pillarTitle}</dd>
          <dt>Type</dt><dd>{e.type}</dd>
          <dt>Tier</dt><dd>{tierDesc}</dd>
          <dt>Filed</dt><dd>Permanent record</dd>
        </dl>
        <div className="ev-detail-tag-row">
          {(e.tags || []).map(t => (
            <a key={t} href="#" onClick={(ev) => ev.preventDefault()}>#{t}</a>
          ))}
        </div>
        {e.link && e.link !== '#' && (
          <a href={e.link} target="_blank" rel="noopener noreferrer" className="ev-detail-cta">
            Open source <span>↗</span>
          </a>
        )}
      </div>
    </div>
  );
}

function SubmitModal({ open, onClose }) {
  const [form, setForm] = useState({
    pillar: PILLARS[0].id, type: 'Paper', tier: 2,
    title: '', source: '', year: '', excerpt: '', link: '', tags: '',
  });
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  useEffect(() => {
    if (open) {
      setSent(false);
      setSubmitError(null);
      setForm(f => ({ ...f, title: '', source: '', year: '', excerpt: '', link: '', tags: '' }));
    }
  }, [open]);

  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handle = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    const tags = form.tags.split(',').map(s => s.trim()).filter(Boolean);
    const { error } = await supabase.from('evidence').insert({
      pillar_id: form.pillar,
      type:      form.type,
      tier:      Number(form.tier),
      title:     form.title.trim(),
      source:    form.source.trim() || null,
      year:      form.year.trim() || null,
      excerpt:   form.excerpt.trim() || null,
      link:      form.link.trim() || null,
      tags,
      status:    'pending',
    });
    setSubmitting(false);
    if (error) { setSubmitError(error.message); return; }
    setSent(true);
    setTimeout(onClose, 1700);
  };

  if (!open) return null;
  return (
    <div className="ev-modal-backdrop is-open" onClick={onClose}>
      <div className="ev-modal" onClick={(ev) => ev.stopPropagation()}>
        <button className="ev-modal-close" onClick={onClose} aria-label="Close">×</button>
        {sent ? (
          <div className="ev-form-success">
            <div className="check">✓</div>
            <h3 className="ev-detail-title" style={{ textAlign: 'center' }}>Filed.</h3>
            <p className="lead" style={{ textAlign: 'center', marginTop: 12 }}>
              Your evidence has been added to the archive.
            </p>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="ev-detail-eyebrow">
              <span className="ev-type">SUBMIT</span>
            </div>
            <h3 className="ev-detail-title">Add to the archive</h3>
            <p className="ev-detail-src">Anyone may submit. Community peer reviews.</p>

            <div className="ev-form-grid" style={{ marginTop: 12 }}>
              <div className="ev-form-row">
                <label htmlFor="f-pillar">Pillar</label>
                <select id="f-pillar" value={form.pillar} onChange={handle('pillar')}>
                  {PILLARS.map(p => <option key={p.id} value={p.id}>{p.n} · {p.title}</option>)}
                </select>
              </div>
              <div className="ev-form-row">
                <label htmlFor="f-type">Type</label>
                <select id="f-type" value={form.type} onChange={handle('type')}>
                  {['Paper','Book','Podcast','Documentary','Declassified','Testimony','Lecture','Study','Method','Witness','Art','Document'].map(t =>
                    <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>

            <div className="ev-form-row">
              <label>Tier</label>
              <div className="ev-form-radio-row">
                {[{ v: 1, label: 'I — Peer-reviewed' }, { v: 2, label: 'II — Documented' }, { v: 3, label: 'III — Testimony' }].map(t => (
                  <button type="button" key={t.v}
                    className={`ev-form-radio ${Number(form.tier) === t.v ? 'is-active' : ''}`}
                    onClick={() => setForm({ ...form, tier: t.v })}
                  >{t.label}</button>
                ))}
              </div>
            </div>

            <div className="ev-form-row">
              <label htmlFor="f-title">Title</label>
              <input id="f-title" value={form.title} onChange={handle('title')} required placeholder="e.g. The Tao of Physics" />
            </div>

            <div className="ev-form-grid">
              <div className="ev-form-row">
                <label htmlFor="f-source">Source / author</label>
                <input id="f-source" value={form.source} onChange={handle('source')} placeholder="Fritjof Capra · Shambhala" />
              </div>
              <div className="ev-form-row">
                <label htmlFor="f-year">Year</label>
                <input id="f-year" value={form.year} onChange={handle('year')} placeholder="1975" />
              </div>
            </div>

            <div className="ev-form-row">
              <label htmlFor="f-excerpt">Excerpt / why it matters</label>
              <textarea id="f-excerpt" value={form.excerpt} onChange={handle('excerpt')} placeholder="One or two sentences on why this evidence belongs here…" />
            </div>

            <div className="ev-form-grid">
              <div className="ev-form-row">
                <label htmlFor="f-link">Source URL</label>
                <input id="f-link" value={form.link} onChange={handle('link')} placeholder="https://…" />
              </div>
              <div className="ev-form-row">
                <label htmlFor="f-tags">Tags (comma-separated)</label>
                <input id="f-tags" value={form.tags} onChange={handle('tags')} placeholder="quantum, mysticism, capra" />
              </div>
            </div>

            <div className="ev-form-foot">
              <p className="ev-form-hint">
                {submitError ? <span style={{ color: 'var(--accent)' }}>{submitError}</span> : 'Submissions are reviewed for relevance.'}
              </p>
              <button type="submit" className="ev-form-submit" disabled={submitting}>
                {submitting ? 'Filing…' : 'File Evidence →'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function SideRail({ active }) {
  return (
    <aside className="ev-rail" aria-label="Jump to pillar">
      {PILLARS.map(p => (
        <a key={p.id} href={`#${p.id}`} className={active === p.id ? 'is-active' : ''}>
          {p.n}
          <span className="ev-rail-name">{p.title}</span>
        </a>
      ))}
    </aside>
  );
}

export default function Evidence() {
  const [q, setQ] = useState('');
  const [type, setType] = useState('All');
  const [tier, setTier] = useState('all');
  const [sort, setSort] = useState('pillar');
  const [open, setOpen] = useState(null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [activePillar, setActivePillar] = useState(PILLARS[0].id);

  const { evidence: all, loading } = useEvidence();

  const filtered = useMemo(() => {
    const qLower = q.trim().toLowerCase();
    return all.filter(e => {
      if (type !== 'All' && e.type !== type) return false;
      if (tier !== 'all' && String(e.tier) !== tier) return false;
      if (!qLower) return true;
      const blob = [e.title, e.source, e.excerpt, e.body, e.quote, (e.tags || []).join(' '), e.pillarTitle, e.type]
        .filter(Boolean).join(' ').toLowerCase();
      return blob.includes(qLower);
    });
  }, [all, q, type, tier]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    if (sort === 'tier') arr.sort((a, b) => a.tier - b.tier);
    else if (sort === 'year-desc') arr.sort((a, b) => parseInt(b.year, 10) - parseInt(a.year, 10));
    else if (sort === 'year-asc') arr.sort((a, b) => parseInt(a.year, 10) - parseInt(b.year, 10));
    else if (sort === 'title') arr.sort((a, b) => a.title.localeCompare(b.title));
    return arr;
  }, [filtered, sort]);

  const counts = useMemo(() => {
    const total = all.length;
    const tier1 = all.filter(e => e.tier === 1).length;
    const tier2 = all.filter(e => e.tier === 2).length;
    const tier3 = all.filter(e => e.tier === 3).length;
    const byType = { All: filtered.length };
    ['Paper', 'Book', 'Podcast', 'Documentary', 'Declassified', 'Testimony', 'Lecture'].forEach(t => {
      byType[t] = all.filter(e => e.type === t && (tier === 'all' || String(e.tier) === tier) && (!q || JSON.stringify(e).toLowerCase().includes(q.toLowerCase()))).length;
    });
    return { total, tier1, tier2, tier3, type: byType };
  }, [all, filtered, q, tier]);

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY + 200;
      let cur = PILLARS[0].id;
      for (const p of PILLARS) {
        const el = document.getElementById(p.id);
        if (el && el.offsetTop <= y) cur = p.id;
      }
      setActivePillar(cur);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = (!!open || submitOpen) ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open, submitOpen]);

  // Scroll to hash on load
  useEffect(() => {
    if (window.location.hash) {
      const id = window.location.hash.slice(1);
      const el = document.getElementById(id);
      if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth' }), 300);
    }
  }, []);

  return (
    <div className="ev-shell">
      <Nav />
      <Hero count={counts.total} tier1Count={counts.tier1} tier2Count={counts.tier2} tier3Count={counts.tier3} />

      <Controls
        q={q} setQ={setQ}
        type={type} setType={setType}
        tier={tier} setTier={setTier}
        sort={sort} setSort={setSort}
        onSubmit={() => setSubmitOpen(true)}
        counts={counts}
      />

      <SideRail active={activePillar} />

      <main className="ev-pillars">
        {loading ? (
          <div style={{ textAlign: 'center', padding: '4rem', opacity: 0.5, letterSpacing: '0.1em', fontSize: '0.85rem' }}>
            LOADING ARCHIVE…
          </div>
        ) : sort === 'pillar' ? (
          PILLARS.map(p => (
            <PillarSection
              key={p.id}
              pillar={p}
              items={sorted.filter(e => e.pillarId === p.id)}
              onOpen={setOpen}
            />
          ))
        ) : (
          <FlatGrid items={sorted} onOpen={setOpen} />
        )}
      </main>

      <DetailModal e={open} onClose={() => setOpen(null)} />
      <SubmitModal
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
      />
    </div>
  );
}
