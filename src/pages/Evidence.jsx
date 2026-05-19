import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { BrandMark } from '../components/Sigil';
import { PILLARS, useEvidence, useTierCounts, useTypeCounts, STATUS_LABEL, openChallenge } from '../evidence-data';
import { supabase } from '../lib/supabase';
import { isPeerActive, getPeerHandle, signAttestation, openChallengeOnChain, submitEvidenceOnChain, waitForTx, CONSENSUS_ADDR, getChallengeCooldownRemaining, computeContentHash } from '../lib/wallet';
import { markEvidenceOnchain } from '../evidence-data';
import '../styles/interstellar.css';
import '../styles/evidence.css';

function EvidenceBadge({ status }) {
  if (!status) return null;
  const map = {
    canon:      { label: 'Canon',      cls: 'ev-badge-reaffirmed' },
    approved:   { label: 'Canon',      cls: 'ev-badge-reaffirmed' },
    contested:  { label: 'Contested',  cls: 'ev-badge-contested'  },
    deprecated: { label: 'Deprecated', cls: 'ev-badge-deprecated' },
    reaffirmed: { label: 'Reaffirmed', cls: 'ev-badge-reaffirmed' },
  };
  const cfg = map[status];
  if (!cfg) return null;
  return <span className={`ev-status-badge ${cfg.cls}`}>{cfg.label}</span>;
}

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
    { id: 'manifesto',   label: 'Manifesto',   href: '/#manifesto' },
    { id: 'pillars',     label: 'Pillars',     href: '/#pillars' },
    { id: 'book',        label: 'Thesis',      href: '/#book' },
    { id: 'peace',       label: 'Peace',       href: '/#peace' },
    { id: 'evidence',    label: 'Evidence',    href: '#top' },
    { id: 'behaviour',   label: 'Alignment',   href: '/alignment/' },
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
          <p className="lead">
            <a href="/artefacts/blockchain/whitepaper.pdf" className="mono"
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
        <span><i className="ev-tier-dot t1" /> Tier I — Peer-reviewed · Declassified</span>
        <span><i className="ev-tier-dot t2" /> Tier II — Documented · Art</span>
        <span><i className="ev-tier-dot t3" /> Tier III — Testimony · First-person</span>
      </div>
    </header>
  );
}

function Controls({ q, setQ, type, setType, tier, setTier, sort, setSort, onSubmit, counts }) {
  const dynamicTypes = Object.entries(counts.type)
    .filter(([k, v]) => k !== 'All' && v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
  const typeChips = ['All', ...dynamicTypes];
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
  const isDeprecated = e.status === 'deprecated';
  return (
    <button
      id={`ev-${e.id}`}
      className={`ev-card${isDeprecated ? ' is-deprecated' : e.status === 'contested' ? ' is-contested' : ''}`}
      onClick={() => onOpen(e)}
    >
      <div className="ev-card-top">
        <span className="ev-type">{e.type}</span>
        <span className="ev-tier" data-tier={e.tier}>
          <span className="bar"><i /><i /><i /></span>
          {tierLabel}
        </span>
        <EvidenceBadge status={e.status} />
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

const PILLAR_PAGE_SIZE = 6;
function PillarSection({ pillar, items, onOpen }) {
  const countedItems = items.filter(e => e.status !== 'deprecated').length;
  const [visible, setVisible] = useState(PILLAR_PAGE_SIZE);

  // Reset pagination when the underlying item set changes (filter/sort/search).
  const itemsKey = items.map(e => e.id).join(',');
  useEffect(() => { setVisible(PILLAR_PAGE_SIZE); }, [itemsKey]);

  const shown      = items.slice(0, visible);
  const ghostCount = shown.length === 0 ? 0 : (3 - (shown.length % 3)) % 3;
  const remaining  = items.length - shown.length;

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
          <b>{countedItems}</b>
          entries
        </div>
      </div>
      <div className="ev-grid">
        {items.length === 0 ? (
          <div className="ev-empty">No matches in this pillar — clear filters or submit the first one.</div>
        ) : (
          <>
            {shown.map(e => <EvCard key={e.id} e={e} onOpen={onOpen} />)}
            {Array.from({ length: ghostCount }, (_, i) => (
              <div key={`ghost-${i}`} className="ev-card-ghost" aria-hidden="true" />
            ))}
          </>
        )}
      </div>
      {remaining > 0 && (
        <div className="ev-pillar-more">
          <button
            type="button"
            className="ev-pillar-more-btn"
            onClick={() => setVisible(v => v + PILLAR_PAGE_SIZE)}
          >
            Load {Math.min(PILLAR_PAGE_SIZE, remaining)} more
            <span className="ev-pillar-more-count">· {remaining} hidden</span>
          </button>
        </div>
      )}
    </section>
  );
}

function FlatGrid({ items, onOpen }) {
  const countedItems = items.filter(e => e.status !== 'deprecated').length;
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
          <b>{countedItems}</b>
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

function DetailModal({ e, onClose, walletPeer }) {
  const [challengeOpen, setChallengeOpen] = useState(false);
  const [challengeReason, setChallengeReason] = useState('');
  const [challenging, setChallenging] = useState(false);
  const [challenged, setChallenged] = useState(false);
  const [chainWarning, setChainWarning] = useState(null);

  useEffect(() => {
    const onKey = (ev) => { if (ev.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    setChallengeOpen(false);
    setChallengeReason('');
    setChallenged(false);
  }, [e?.id]);

  if (!e) return null;

  const tierLabel = e.tier === 1 ? 'I' : e.tier === 2 ? 'II' : 'III';
  const tierDesc  = e.tier === 1 ? 'I — Peer-reviewed / Declassified' : e.tier === 2 ? 'II — Documented / Institutional' : 'III — Testimony / First-person';
  const isCanon      = e.status === 'canon' || e.status === 'approved' || e.status === 'reaffirmed';
  const isContested  = e.status === 'contested';
  const isDeprecated = e.status === 'deprecated';

  const handleChallenge = async (ev) => {
    ev.preventDefault();
    if (!walletPeer?.addr || !walletPeer?.isPeer) return;
    if (challengeReason.trim().length === 0) return;
    setChallenging(true);
    setChainWarning(null);

    // EIP-712 signature is mandatory.  If the user rejects in MetaMask we
    // surface a clear warning rather than silently writing an unsigned row.
    let sig;
    try {
      sig = await signAttestation({
        evidenceId: e.id,
        phase:      'challenge',
        verdict:    'challenge',
        note:       challengeReason.trim(),
      }, walletPeer.addr);
    } catch (sigErr) {
      setChainWarning(sigErr?.code === 4001
        ? 'Signature rejected — challenge not filed.'
        : `Signature failed — ${sigErr?.message || 'unknown error'}`);
      setChallenging(false);
      return;
    }

    let txHash = null;
    if (CONSENSUS_ADDR) {
      try {
        txHash = await openChallengeOnChain(e.id);
      } catch (txErr) {
        setChainWarning(txErr?.message?.includes('rejected')
          ? 'Transaction rejected — challenge not recorded.'
          : `On-chain call failed — ${txErr?.message || 'unknown error'}`);
        setChallenging(false);
        return;
      }
      try { await waitForTx(txHash); }
      catch (txErr) {
        setChainWarning('Transaction reverted — challenge not recorded.');
        setChallenging(false);
        return;
      }
    }

    try {
      await openChallenge(e, walletPeer.addr, walletPeer.handle || '', challengeReason.trim(), sig, txHash);
    } catch (syncErr) {
      // On-chain succeeded; cache will catch up via indexer.
    }
    setChallenging(false);
    setChallenged(true);
  };

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
          <EvidenceBadge status={e.status} />
        </div>

        <h3 className={`ev-detail-title${isDeprecated ? ' ev-detail-title-deprecated' : ''}`}>{e.title}</h3>
        <p className="ev-detail-src">
          <span>{e.source}</span> · <span className="year">{e.year}</span>
          <span> · Pillar {e.pillarNum} {e.pillarTitle}</span>
        </p>

        {/* Deprecated notice */}
        {isDeprecated && (
          <div className="ev-deprecated-notice">
            <div className="ev-deprecated-notice-label">Deprecated by the network</div>
            <p>{e.deprecated_reason || e.challenge_reason || 'This evidence was challenged and deprecated by a supermajority of peers.'}</p>
            {e.deprecated_at && (
              <div className="ev-deprecated-notice-date">
                {new Date(e.deprecated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
              </div>
            )}
          </div>
        )}

        {/* Contested notice */}
        {isContested && e.challenge_reason && (
          <div className="ev-contested-notice">
            <div className="ev-contested-notice-label">Under challenge</div>
            <p>{e.challenge_reason}</p>
            <a href="/peer-review/" className="ev-contested-notice-link">
              Vote in Peer Review →
            </a>
          </div>
        )}

        <div className="ev-detail-body">
          <p>{e.excerpt}</p>
          {e.body && <p>{e.body}</p>}
          {e.quote && <p className="ev-detail-quote">&ldquo;{e.quote}&rdquo;</p>}
        </div>

        <dl className="ev-detail-meta">
          <dt>Pillar</dt><dd>{e.pillarNum} · {e.pillarTitle}</dd>
          <dt>Type</dt><dd>{e.type}</dd>
          <dt>Tier</dt><dd>{tierDesc}</dd>
          <dt>Status</dt><dd>{STATUS_LABEL[e.status] || 'Canon'}</dd>
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

        {/* Challenge section — only for canon / reaffirmed evidence */}
        {isCanon && !challenged && (
          <div className="ev-challenge-section">
            {!walletPeer?.isPeer ? (
              <p style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em', color: 'var(--ink-faint)', margin: 0 }}>
                <a href="/peer-review/" style={{ color: 'var(--accent-2)' }}>Connect as a verified peer →</a>
                {' '}to challenge this evidence.
              </p>
            ) : walletPeer.cooldownSecs > 0 ? (
              <p style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '0.12em', color: 'var(--warn)', margin: 0 }}>
                Challenge cooldown active — next challenge available in{' '}
                {Math.ceil(walletPeer.cooldownSecs / 86400)} day{Math.ceil(walletPeer.cooldownSecs / 86400) === 1 ? '' : 's'}{' '}
                ({new Date(Date.now() + walletPeer.cooldownSecs * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}).
              </p>
            ) : !challengeOpen ? (
              <button className="ev-challenge-trigger" onClick={() => setChallengeOpen(true)}>
                Challenge this evidence
              </button>
            ) : (
              <form className="ev-challenge-form" onSubmit={handleChallenge}>
                <div className="ev-challenge-form-label">State your grounds</div>
                <p className="ev-challenge-form-sub">
                  What specific claim is wrong, misleading, or no longer supported?
                  Other verified peers will vote to deprecate or defend.
                </p>
                <textarea
                  autoFocus
                  value={challengeReason}
                  onChange={ev => setChallengeReason(ev.target.value)}
                  placeholder="Be specific."
                  rows={4}
                />
                <div className="ev-challenge-form-foot">
                  <button type="button" className="ev-challenge-cancel" onClick={() => { setChallengeOpen(false); setChallengeReason(''); }}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="ev-challenge-submit"
                    disabled={challengeReason.trim().length === 0 || challenging}
                  >
                    {challenging ? 'Filing…' : 'File challenge →'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        {challenged && (
          <div className="ev-challenge-section ev-challenge-filed">
            Challenge filed. Verified peers will vote in{' '}
            <a href="/peer-review/">Peer Review →</a>
            {chainWarning && (
              <p style={{ marginTop: 8, fontSize: 11, fontFamily: 'var(--mono)', letterSpacing: '0.08em', color: 'var(--warn)', opacity: 0.85 }}>
                ⚠ {chainWarning}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SubmitModal({ open, onClose, walletPeer }) {
  const [form, setForm] = useState({
    pillar: PILLARS[0].id, type: 'Paper', tier: 2,
    title: '', source: '', year: '', excerpt: '', link: '', tags: '',
  });
  const [sent, setSent]             = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [newId, setNewId]           = useState(null);  // UUID of the inserted row
  const [chainPending, setChainPending] = useState(false);
  const [chainDone, setChainDone]   = useState(false);

  useEffect(() => {
    if (open) {
      setSent(false);
      setSubmitError(null);
      setNewId(null);
      setChainDone(false);
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
    const { data: inserted, error } = await supabase.from('evidence').insert({
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
    }).select('id').single();
    setSubmitting(false);
    if (error) { setSubmitError(error.message); return; }
    setNewId(inserted?.id || null);
    setSent(true);
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
              Your evidence has been added to the pending queue.
            </p>
            {walletPeer?.isPeer && CONSENSUS_ADDR && newId && !chainDone && (
              <button
                className="ev-form-submit"
                style={{ marginTop: 20, width: '100%' }}
                disabled={chainPending}
                onClick={async () => {
                  setChainPending(true);
                  try {
                    // Bind the off-chain content into the on-chain record.
                    const contentHash = await computeContentHash({
                      title:     form.title.trim(),
                      source:    form.source.trim() || null,
                      year:      form.year.trim()   || null,
                      excerpt:   form.excerpt.trim() || null,
                      link:      form.link.trim()   || null,
                      tier:      Number(form.tier),
                      pillar_id: form.pillar,
                    });
                    const txHash = await submitEvidenceOnChain(newId, Number(form.tier), contentHash);
                    await waitForTx(txHash);
                    try { await markEvidenceOnchain(newId, walletPeer.addr, txHash); } catch { /* indexer reconciles */ }
                    setChainDone(true);
                  } catch {
                    // User rejected or tx failed — don't block the UX
                  } finally {
                    setChainPending(false);
                  }
                }}
              >
                {chainPending ? 'Registering on-chain…' : 'Register on-chain →'}
              </button>
            )}
            {chainDone && (
              <p style={{ textAlign: 'center', marginTop: 12, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-faint)' }}>
                On-chain registration confirmed.
              </p>
            )}
            {!walletPeer?.isPeer && (
              <p style={{ textAlign: 'center', marginTop: 16, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-faint)' }}>
                <a href="/peer-review/" style={{ color: 'var(--accent-2)' }}>Connect as a peer →</a>
                {' '}to register this submission on-chain.
              </p>
            )}
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
                  {['Paper','Book','Podcast','Documentary','Video','Declassified','Testimony','Lecture','Study','Method','Witness','Art','Photograph','Document'].map(t =>
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

  // Minimal wallet state for challenge gating — full peer auth lives in PeerReview
  const [walletPeer, setWalletPeer] = useState(null); // { addr, handle, isPeer }

  // Silent wallet check on load; recheck whenever the connected account changes.
  useEffect(() => {
    if (!window.ethereum || !CONSENSUS_ADDR) return;

    const checkAccount = async (addr) => {
      if (!addr) { setWalletPeer(null); return; }
      const peer         = await isPeerActive(addr);
      const handle       = peer ? await getPeerHandle(addr) : '';
      const cooldownSecs = peer ? await getChallengeCooldownRemaining(addr) : 0;
      setWalletPeer({ addr, handle, isPeer: peer, cooldownSecs });
    };

    window.ethereum.request({ method: 'eth_accounts' })
      .then(accounts => checkAccount(accounts[0] || null))
      .catch(() => {});

    const onAccountsChanged = (accounts) => checkAccount(accounts[0] || null);
    window.ethereum.on('accountsChanged', onAccountsChanged);
    return () => window.ethereum.removeListener?.('accountsChanged', onAccountsChanged);
  }, []);

  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const { evidence, loading, total, hasMore, loadMore } = useEvidence(debouncedQ, type, tier, sort);
  const tierCounts = useTierCounts();
  const typeCounts = useTypeCounts();

  const counts = useMemo(() => ({
    ...tierCounts,
    type: { All: tierCounts.total, ...typeCounts },
  }), [tierCounts, typeCounts]);

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

  // Scroll to hash once the archive has rendered. Wait for evidence to load
  // so the target pillar section exists in the DOM before scrolling.
  // For `#ev-<uuid>` hashes we additionally open the evidence modal — if the
  // row isn't in the current paginated list, fall back to a direct fetch so
  // deep-links from the chain log still surface the source.
  const hashScrolledRef = useRef(false);
  useEffect(() => {
    if (hashScrolledRef.current) return;
    if (loading || !window.location.hash) return;
    const hashId = window.location.hash.slice(1);
    hashScrolledRef.current = true;

    if (hashId.startsWith('ev-')) {
      const evId   = hashId.slice(3);
      const loaded = evidence.find(it => it.id === evId);
      const el     = document.getElementById(hashId);
      if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      if (loaded) {
        setOpen(loaded);
      } else {
        supabase.from('evidence').select('*').eq('id', evId).maybeSingle()
          .then(({ data }) => { if (data) setOpen(data); });
      }
      return;
    }

    const el = document.getElementById(hashId);
    if (!el) return;
    requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [loading, evidence]);

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
        {loading && evidence.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '4rem', opacity: 0.5, letterSpacing: '0.1em', fontSize: '0.85rem' }}>
            LOADING ARCHIVE…
          </div>
        ) : sort === 'pillar' && !debouncedQ && type === 'All' && tier === 'all' ? (
          PILLARS.map(p => (
            <PillarSection
              key={p.id}
              pillar={p}
              items={evidence.filter(e => e.pillarId === p.id)}
              onOpen={setOpen}
            />
          ))
        ) : (
          <FlatGrid items={evidence} onOpen={setOpen} />
        )}

        {hasMore && (
          <div style={{ textAlign: 'center', padding: '2rem 1rem 4rem' }}>
            <button className="ev-submit-btn" onClick={loadMore} disabled={loading}>
              {loading ? 'Loading…' : `Load more · ${evidence.length} / ${total ?? evidence.length} shown`}
            </button>
          </div>
        )}
      </main>

      <DetailModal e={open} onClose={() => setOpen(null)} walletPeer={walletPeer} />
      <SubmitModal
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        walletPeer={walletPeer}
      />
    </div>
  );
}
