import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import WalletButton from '../components/WalletButton';
import AttestationVerifier from '../components/AttestationVerifier';
import { BrandSigil } from '../components/Sparkle';
import { useTierCounts, useTaxonomy, useRecentVotes, usePeerHandleMap, fetchBindingPreview } from '../evidence-data';
import metamaskFox from '../assets/metamask-fox.svg';

// Lazy so the evidence-detail styles + body only download when a visitor
// actually opens a record, keeping the landing page's initial payload light.
const EvidencePreviewModal = lazy(() => import('../components/EvidencePreviewModal'));
import '../styles/shared.css';
import '../styles/home.css';

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24); return `${d} d ago`;
}

// On-chain signed verdicts. `endorse` (taxonomy) is the same act as `approve`.
const VERDICT_LABEL = { approve: 'Approved', endorse: 'Approved', reject: 'Rejected', challenge: 'Challenged', defend: 'Defended' };
const verdictClass = (v) => (v === 'endorse' ? 'approve' : v);
const SHORT = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function jazzGradient(addr = '0x0') {
  const h = hashStr(String(addr).toLowerCase());
  const a = h % 360, b = (h >> 3) % 360, c = (h >> 6) % 360;
  return `conic-gradient(from ${h % 360}deg, oklch(0.72 0.14 ${a}), oklch(0.72 0.14 ${b}), oklch(0.72 0.14 ${c}), oklch(0.72 0.14 ${a}))`;
}
const Jazz = ({ addr, size = 18 }) => (
  <span className="jazz" style={{ width: size, height: size, borderRadius: '50%', background: jazzGradient(addr), flexShrink: 0 }} />
);

// Apple-style scroll reveal: fade + slide-up the first time a section enters the
// viewport. Honors prefers-reduced-motion (shows instantly).
function Reveal({ children }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setShown(true); return; }
    // Reveal only once the section has scrolled well into view — its top has
    // risen past the viewport's vertical middle — for the modern "settle into
    // place" feel. Only fallback: when the page can't scroll any further (the
    // last section, now that there's no footer) so it never stays stuck hidden.
    const THRESHOLDS = Array.from({ length: 21 }, (_, i) => i / 20);
    const atPageBottom = () =>
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    const io = new IntersectionObserver(
      ([entry]) => {
        const vh = window.innerHeight || document.documentElement.clientHeight;
        const topPastLine = entry.boundingClientRect.top <= vh * 0.7;
        if (entry.isIntersecting && (topPastLine || atPageBottom())) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: THRESHOLDS },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} className={`reveal${shown ? ' is-visible' : ''}`}>{children}</div>;
}

function WalletIcon() {
  return <img className="wallet-icon" src={metamaskFox} alt="" width="14" height="14" aria-hidden="true" />;
}

function Nav() {
  return (
    <nav className="nav">
      <div className="nav-inner">
        <a href="#top" className="brand">
          <BrandSigil />
          <span className="brand-text">The Disclosure Platform<small>DeSci · Evidence Network</small></span>
        </a>
        <div className="nav-links">
          <a href="#top" className="is-active">Home</a>
          <a href="/evidence/">Evidence</a>
          <a href="/peer-review/">Peer Review</a>
        </div>
        <div className="nav-right">
          <WalletButton />
        </div>
      </div>
    </nav>
  );
}

// Product tour — poster thumbnail in the hero; click opens a centred lightbox
// that plays the video at its native aspect ratio with native controls.
function HeroOrbit() {
  const [open, setOpen] = useState(false);
  const videoRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    // Autoplay once the modal is mounted so the user lands on a moving frame.
    const v = videoRef.current;
    if (v) { try { v.currentTime = 0; v.play(); } catch {} }
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="h-orbit h-tour"
        onClick={() => setOpen(true)}
        aria-label="Play product tour"
      >
        <img
          className="h-tour-poster"
          src="/artefacts/tour-poster.jpg"
          alt=""
          aria-hidden="true"
        />
        <span className="h-tour-play" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
        </span>
      </button>
      {open && (
        <div className="h-tour-modal" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
          <div className="h-tour-modal-frame" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="h-tour-modal-close"
              onClick={() => setOpen(false)}
              aria-label="Close"
            >
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" /></svg>
            </button>
            <video
              ref={videoRef}
              className="h-tour-modal-video"
              src="/artefacts/tour.mp4"
              poster="/artefacts/tour-poster.jpg"
              controls
              playsInline
              preload="metadata"
              controlsList="nodownload noremoteplayback"
            />
          </div>
        </div>
      )}
    </>
  );
}

function Hero() {
  return (
    <section id="top" className="h-hero">
      <div className="h-hero-inner">
        <div className="h-hero-left">
          <span className="eyebrow">Public · Permanent · Peer-reviewed</span>
          <h1 className="display">Evidence,<br /><em>verified</em><br />by peers.</h1>
          <p className="lead">
            The truth the mainstream won't host — no data harvesting, no likes,
            no ads, no status. Every claim is filed against the source that
            backs it, checked in the open by named reviewers, and saved to a
            permanent public record anyone can inspect.
          </p>
          <p className="lead-link">
            <a href="/artefacts/labour-of-love.pdf" target="_blank" rel="noopener noreferrer">
              Read the philosophy — A Labour of Love <span aria-hidden="true">→</span>
            </a>
          </p>
          <div className="h-hero-cta">
            <a className="btn btn--primary" href="/evidence/">Explore evidence <span>→</span></a>
            <a className="btn" href="#become-a-peer">Become a peer</a>
          </div>
        </div>
        <div className="h-hero-right">
          <div className="h-orbit-side">
            <HeroOrbit />
          </div>
        </div>
      </div>
    </section>
  );
}

function SimpleIdea() {
  const rows = [
    ['I', 'Every claim reaches an outcome.', 'No submission sits in limbo. Peers accept it into the archive, turn it away, or set it aside if they don’t reach a decision in time — and anything set aside can be re-submitted when fresh evidence arrives.'],
    ['II', 'Every decision is signed by a named peer.', 'Each vote is cast by a named reviewer and signed with their own secure key, so anyone can confirm who decided what. Every vote is on the record, every signer is named, every disagreement is kept.'],
    ['III', 'Every decision can be reopened.', 'Nothing is ever locked. Peers can re-open a past decision, defend it, retire topics that no longer hold up, and grow the archive wider (new categories) and deeper (new topics) — all by agreement among named peers.'],
  ];
  return (
    <section className="h-idea">
      <div className="h-idea-grid">
        <div>
          <span className="eyebrow">The simple idea</span>
          <h2 className="h2" style={{ marginTop: 20 }}>A living agreement — reached by named peers, kept on an open public record.</h2>
        </div>
        <div className="h-three">
          {rows.map(([num, h, p]) => (
            <div className="h-three-row" key={num}>
              <span className="num">{num}</span>
              <div>
                <h3>{h}</h3>
                <p>{p}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// One row of the home vote feed. Holds local state for the optional
// deliberation note: a peer may attach a note when voting, so the reveal toggle
// only renders when one exists, expanding a full-width panel beneath the row —
// mirroring the Peer Review vote history's LogRow.
function VoteRow({ v, isNew, onOpen, handleMap }) {
  const [showNote, setShowNote] = useState(false);
  const note = (v.note || '').trim();
  const peerName = v.peer_handle || handleMap[v.peer_addr?.toLowerCase()] || SHORT(v.peer_addr);
  return (
    <div className={`h-vote-row${isNew ? ' is-new' : ''}${showNote ? ' is-noted' : ''}`} role="row">
      <span className="t" role="cell">{timeAgo(v.created_at)}</span>
      <span className="peer" role="cell" title={v.peer_addr}><Jazz addr={v.peer_addr} size={18} /><span className="peer-name">{peerName}</span></span>
      <span className={`verdict ${verdictClass(v.verdict)}`} role="cell">{VERDICT_LABEL[v.verdict] || v.verdict}</span>
      <span className="on" role="cell">
        {v.evidence_title
          ? <button type="button" className="h-vote-evi" onClick={() => onOpen(v)} title="Open the full evidence record">{v.evidence_title}</button>
          : <span className="evi">Evidence</span>}
      </span>
      <span className="note" role="cell">
        {note
          ? (
            <button
              type="button"
              className={`h-vote-note-btn ${showNote ? 'is-open' : ''}`}
              onClick={() => setShowNote(s => !s)}
              aria-expanded={showNote}
              title={showNote ? 'Hide deliberation note' : 'Show the peer’s deliberation note'}
            >
              <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Note
            </button>
          )
          : <span style={{ color: 'var(--ink-faint)' }}>—</span>}
      </span>
      <span className="proof" role="cell">
        <AttestationVerifier a={v} handle={peerName} handleMap={handleMap} />
      </span>
      {note && showNote && (
        <div className="h-vote-note">
          <span className="h-vote-note-label">Deliberation note</span>
          <p>{note}</p>
        </div>
      )}
    </div>
  );
}

function LiveArchive({ counts, pillarCount, topicCount, peerCount, votes, handleMap }) {
  const prev = useRef(counts.total);
  const [ticking, setTicking] = useState(false);
  const [preview, setPreview] = useState(null);

  const openPreview = async (v) => {
    const p = await fetchBindingPreview({ bindingId: v.binding_id, evidenceId: v.evidence_id, pillarId: v.pillar_id, topicId: v.topic_id });
    if (p) setPreview(p);
  };
  useEffect(() => {
    if (counts.total > prev.current) {
      setTicking(true);
      const t = setTimeout(() => setTicking(false), 1600);
      prev.current = counts.total;
      return () => clearTimeout(t);
    }
    prev.current = counts.total;
  }, [counts.total]);

  return (
    <section className="h-archive">
      <header className="h-archive-head">
        <div>
          <span className="eyebrow">The archive — live</span>
          <h2 className="h2" style={{ marginTop: 20 }}>A public record — of the people,<br /><em>by the people.</em></h2>
        </div>
        <p className="lead">
          Every count is live — it updates the instant a new vote lands. Each
          decision below is a named peer's signed vote, saved to a permanent
          public record. Click any signature to check it yourself. No trust
          required.
        </p>
      </header>

      <div className="h-archive-stats">
        <div className="h-stat is-hero">
          <div className="lab">Live · global</div>
          <div className={`v${ticking ? ' is-ticking' : ''}`}>
            <span className="num">{counts.total.toLocaleString()}</span><span className="u">entries</span>
          </div>
        </div>
        <div className="h-stat">
          <div className="lab">Categories</div>
          <div className="v">{pillarCount}<span className="u">wide</span></div>
        </div>
        <div className="h-stat">
          <div className="lab">Topics</div>
          <div className="v">{topicCount}<span className="u">deep</span></div>
        </div>
        <div className="h-stat">
          <div className="lab">Verified peers</div>
          <div className="v">{peerCount ?? '—'}<span className="u">named</span></div>
        </div>
      </div>

      <div className="h-votes">
        <div className="h-votes-head">
          <span className="h-votes-label"><span className="dot" /> Live decisions · every vote signed &amp; on the public record</span>
          <a className="h-votes-link" href="/peer-review/?observe=1">Open the full vote history <span aria-hidden="true">→</span></a>
        </div>
        <div className="h-votes-table" role="table" aria-label="Recent on-chain peer votes">
          <div className="h-vote-row is-head" role="row">
            <span role="columnheader">When</span>
            <span role="columnheader">Peer</span>
            <span role="columnheader">Verdict</span>
            <span role="columnheader">On the record</span>
            <span role="columnheader">Note</span>
            <span role="columnheader">Proof</span>
          </div>
          {votes.length === 0 ? (
            <div className="h-votes-empty">No votes yet — the record opens with the first signed vote.</div>
          ) : votes.map((v, i) => (
            <VoteRow key={v.id} v={v} isNew={i === 0} onOpen={openPreview} handleMap={handleMap} />
          ))}
        </div>
      </div>
      {preview && (
        <Suspense fallback={null}>
          <EvidencePreviewModal b={preview} onClose={() => setPreview(null)} />
        </Suspense>
      )}
    </section>
  );
}

function BecomePeer({ peerCount }) {
  const steps = [
    ['I', 'Sign in securely', 'Use a secure crypto wallet (like MetaMask) — no email, no profile. Your wallet is your identity. Reading the archive and submitting evidence stay open to everyone; becoming a peer is what unlocks voting, contesting, and proposing new topics.'],
    ['II', 'Get nominated by a peer', 'An existing peer nominates you with a display name. The named network vouches for who joins — there are no anonymous moderators and no application form.'],
    ['III', 'Earn support from peers', 'Other peers back your nomination. The number needed grows with the network — one for every ten active peers, capped at 10 once it passes 100. Reach that count and you’re approved automatically. No admin in the loop.'],
    ['IV', 'Help verify the record', 'As a peer you accept evidence into the archive, raise and answer challenges, and propose new categories and topics. Every action is signed with your key and saved to one permanent public record.'],
  ];
  return (
    <section id="become-a-peer" className="h-peer">
      <div className="h-peer-grid">
        <div className="h-peer-intro">
          <span className="eyebrow">Become a verified peer</span>
          <h2 className="h2" style={{ marginTop: 20 }}>Join the named network that verifies the record.</h2>
          <p className="lead">
            Membership is run entirely by the peers themselves — you're
            nominated, supported, and approved by the group, never by an
            administrator.{peerCount != null ? ` ${peerCount} verified peers today.` : ''}
          </p>
          <div className="h-peer-cta">
            <a className="btn btn--primary" href="/peer-review/"><WalletIcon /> Open Peer Review <span>→</span></a>
            <a className="btn" href="/artefacts/peer-review-engineering.pdf" target="_blank" rel="noopener noreferrer">Read the engineering paper <span aria-hidden="true">↗</span></a>
          </div>
        </div>
        <div className="h-three">
          {steps.map(([num, h, p]) => (
            <div className="h-three-row" key={num}>
              <span className="num">{num}</span>
              <div>
                <h3>{h}</h3>
                <p>{p}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Manifesto() {
  const nots = [
    'No likes', 'No feed', 'No ranking', 'No AI algorithm', 'No notifications',
    'No followers', 'No bots', 'No anonymous mods', 'No shadowbans',
    'No ads', 'No paid reach', 'No revenue model',
    'No data collection', 'No takedowns', 'No closed source',
  ];
  return (
    <section className="h-manifesto">
      <div className="h-manifesto-grid">
        <p className="h-quote"><span className="drop">&ldquo;</span>A feed forgets. A record remembers.<span style={{ color: 'var(--accent-ink)' }}>&rdquo;</span></p>
        <div className="h-manifesto-side">
          <span className="eyebrow">What this is not</span>
          <ul className="h-no-list">
            {nots.map(n => <li key={n}>{n}</li>)}
          </ul>
          <p>
            <strong>The Disclosure Platform</strong> is a <strong>decentralized
            science (DeSci) network</strong> — infrastructure for evidence, not a
            place to socialise. There is no follower count, no profile photo, no
            engagement loop. Peers carry handles and signatures, not vanity.
          </p>
          <p>
            Submissions are public the instant they land. The rules are enforced
            by open code, not a company. Anyone may read; named peers verify;
            the public watches.
          </p>
        </div>
      </div>
    </section>
  );
}

// Direct line to the people behind the record — no ticket queue, no form that
// vanishes. A prominent mailto card with a copy-to-clipboard affordance, in
// keeping with the "verify it yourself" ethos of the rest of the page.
const CONTACT_EMAIL = 'genesis@thedisclosureplatform.com';
function Contact() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CONTACT_EMAIL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard blocked — the mailto link still works */ }
  };
  return (
    <section id="contact" className="h-contact">
      <div className="h-contact-card">
        <span className="eyebrow">Get in touch</span>
        <h2 className="h2" style={{ marginTop: 18 }}>Questions or evidence?<br /><em>Write to us directly.</em></h2>
        <p className="lead">
          No ticket queue, no chatbot, no form that vanishes into a void — one
          inbox, read by the people who keep the record.
        </p>
        <div className="h-contact-actions">
          <a className="h-contact-mail" href={`mailto:${CONTACT_EMAIL}`}>
            <span className="h-contact-mail-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22"><rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M4 7.5l8 5.2 8-5.2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </span>
            <span className="h-contact-mail-text">
              <span className="lab">Email the team</span>
              <span className="addr">{CONTACT_EMAIL}</span>
            </span>
            <span className="h-contact-mail-go" aria-hidden="true">→</span>
          </a>
          <button
            type="button"
            className={`h-contact-copy${copied ? ' is-copied' : ''}`}
            onClick={copy}
            aria-label={copied ? 'Address copied' : `Copy ${CONTACT_EMAIL} to clipboard`}
          >
            {copied
              ? <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M5 12.5l4 4 10-10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
              : <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M5 15V5a2 2 0 0 1 2-2h10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>}
            {copied ? 'Copied' : 'Copy address'}
          </button>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const counts = useTierCounts();
  const tax = useTaxonomy();
  const votes = useRecentVotes(6);
  const handleMap = usePeerHandleMap();
  const [peerCount, setPeerCount] = useState(null);

  // Peer count lives on-chain. Load it lazily so ethers stays out of the initial
  // Home bundle; the read uses a public RPC fallback so it resolves even for
  // wallet-less visitors.
  useEffect(() => {
    let cancelled = false;
    import('../lib/wallet')
      .then(m => m.getActivePeerCount?.())
      .then(n => { if (!cancelled && typeof n === 'number') setPeerCount(n); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="shell">
      <Nav />
      <Hero />
      <Reveal><SimpleIdea /></Reveal>
      <Reveal>
        <LiveArchive
          counts={counts}
          pillarCount={tax.pillars.length}
          topicCount={tax.topics.length}
          peerCount={peerCount}
          votes={votes}
          handleMap={handleMap}
        />
      </Reveal>
      <Reveal><BecomePeer peerCount={peerCount} /></Reveal>
      <Reveal><Manifesto /></Reveal>
      <Reveal><Contact /></Reveal>
    </div>
  );
}
