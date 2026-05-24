import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import Element115 from '../components/Element115';
import WalletButton from '../components/WalletButton';
import AttestationVerifier from '../components/AttestationVerifier';
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
          <span className="brand-text">The Disclosure Platform<small>The Web3 Social Network</small></span>
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

// Bohr-model atom of Element 115 (Moscovium) — rotating electron shells around a
// proton/neutron nucleus, with the periodic-table cell.
function HeroOrbit() {
  return (
    <div className="h-orbit" aria-hidden="true">
      <Element115 size="full" />
    </div>
  );
}

function Hero({ counts, pillarCount, peerCount }) {
  const stats = [
    { v: (counts?.total ?? 0).toLocaleString(), lab: 'Evidence' },
    { v: pillarCount ?? '—', lab: 'Pillars' },
    { v: peerCount ?? '—', lab: 'Verified peers' },
  ];
  return (
    <section id="top" className="h-hero">
      <div className="h-hero-inner">
        <div className="h-hero-left">
          <span className="eyebrow">Public · On-chain · Peer-reviewed</span>
          <h1 className="display">Evidence,<br /><em>verified</em><br />by peers.</h1>
          <p className="lead">
            The truth the mainstream won't host — no data harvesting, no likes,
            no ads, no status. Every claim is filed against the record that
            supports it, judged in public by named peers, anchored on the
            blockchain.
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
            <div className="h-orbit-stats">
              {stats.map(s => (
                <div className="h-orbit-stat" key={s.lab}>
                  <div className="v">{s.v}</div>
                  <div className="lab">{s.lab}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SimpleIdea() {
  const rows = [
    ['I', 'Every claim cites its source.', 'Every entry carries its citation — a paper, book, podcast, declassified file, deposition. The claim cannot float; it has a record.'],
    ['II', 'Verified peers attest in public.', 'Named reviewers — wallet-signed, identifiable, accountable — vote to canonize, contest, defend, or deprecate. Every vote is on-chain and signed EIP-712.'],
    ['III', 'The chain remembers.', 'One BSC contract holds the peer set, the Pillar → Topic taxonomy, and the lifecycle. The archive grows wider (new pillars) and deeper (new topics) by peer consensus alone.'],
  ];
  return (
    <section className="h-idea">
      <div className="h-idea-grid">
        <div>
          <span className="eyebrow">The simple idea</span>
          <h2 className="h2" style={{ marginTop: 20 }}>Backed by the record. Judged in public. Anchored on-chain.</h2>
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
      <span className="peer" role="cell" title={v.peer_addr}>{peerName}</span>
      <span className={`verdict ${verdictClass(v.verdict)}`} role="cell">{VERDICT_LABEL[v.verdict] || v.verdict}</span>
      <span className="on" role="cell">
        {v.evidence_title
          ? <button type="button" className="h-vote-evi" onClick={() => onOpen(v)} title="Open the full evidence record">{v.evidence_title}</button>
          : <span className="evi">Evidence</span>}
        {note && (
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
        )}
      </span>
      <span className="proof" role="cell">
        <AttestationVerifier a={v} handle={peerName} />
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
          <h2 className="h2" style={{ marginTop: 20 }}>A public record, ticking up.</h2>
        </div>
        <p className="lead">
          Every count is live — the tally moves the instant a new attestation
          lands. Each verdict below is a named peer's vote, signed EIP-712 and
          settled on BNB Smart Chain. Click any signature to verify it yourself.
          No trust required.
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
          <div className="lab">Pillars</div>
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
          <span className="h-votes-label"><span className="dot" /> Live consensus · every vote signed &amp; on-chain</span>
          <a className="h-votes-link" href="/peer-review/">Open the full vote history <span aria-hidden="true">→</span></a>
        </div>
        <div className="h-votes-table" role="table" aria-label="Recent on-chain peer votes">
          <div className="h-vote-row is-head" role="row">
            <span role="columnheader">When</span>
            <span role="columnheader">Peer</span>
            <span role="columnheader">Verdict</span>
            <span role="columnheader">On the record</span>
            <span role="columnheader">Proof</span>
          </div>
          {votes.length === 0 ? (
            <div className="h-votes-empty">No votes yet — the ledger opens with the first signed attestation.</div>
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
    ['I', 'Connect your wallet', 'Bring a MetaMask wallet on BNB Smart Chain — no email, no profile. Your wallet is your identity. Reading the archive and submitting evidence stay open to everyone; verification is what unlocks reviewing, challenging, and proposing taxonomy.'],
    ['II', 'Get nominated by a peer', 'An existing verified peer nominates your wallet with a handle. The named network vouches for who joins — there are no anonymous moderators and no application form.'],
    ['III', 'Earn endorsements', 'Other verified peers endorse your nomination. The number needed scales with the network — one endorsement for every ten active peers, capped at 10 once the network passes 100. Reach that count and the contract verifies you automatically. No admin in the loop.'],
    ['IV', 'Verify the record', 'As a verified peer you canonize evidence, file and defend challenges, and propose new pillars and topics. Every action is EIP-712 signed and anchored on a single BSC contract.'],
  ];
  return (
    <section id="become-a-peer" className="h-peer">
      <div className="h-peer-grid">
        <div className="h-peer-intro">
          <span className="eyebrow">Become a verified peer</span>
          <h2 className="h2" style={{ marginTop: 20 }}>Join the named network that verifies the record.</h2>
          <p className="lead">
            Membership is governed entirely on-chain by the peers themselves —
            nominated, endorsed, and ratified by consensus, never by an
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
        <p className="h-quote"><span className="drop">&ldquo;</span>A feed forgets. A record remembers.<span style={{ color: 'var(--accent)' }}>&rdquo;</span></p>
        <div className="h-manifesto-side">
          <span className="eyebrow">What this is not</span>
          <ul className="h-no-list">
            {nots.map(n => <li key={n}>{n}</li>)}
          </ul>
          <p>
            <strong>The Disclosure Platform</strong> is infrastructure for evidence,
            not a place to socialise. There is no follower count, no profile photo,
            no engagement loop. Peers carry handles and signatures, not vanity.
          </p>
          <p>
            Submissions are public the instant they land. The contract is the only
            gatekeeper, and the contract is open. Anyone may read; named peers
            verify; the public watches.
          </p>
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
      <Hero counts={counts} pillarCount={tax.pillars.length} peerCount={peerCount} />
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
    </div>
  );
}
