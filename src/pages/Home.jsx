import { useState, useEffect, useRef } from 'react';
import { Sigil, MandalaBg, BrandMark } from '../components/Sigil';
import Pillars from '../components/Pillars';
import PurchaseModal from '../components/PurchaseModal';
import VideoModal from '../components/VideoModal';
import AudioBg from '../components/AudioBg';

function useScrollSpy(ids) {
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY + 140;
      let cur = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.offsetTop <= y) cur = id;
      }
      setActive(cur);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, [ids.join(',')]);
  return active;
}

function useFadeIn() {
  useEffect(() => {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('visible');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12 });

    const observe = () => {
      document.querySelectorAll('.fade-in:not(.visible)').forEach((el) => io.observe(el));
    };
    observe();

    const mo = new MutationObserver(observe);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => { io.disconnect(); mo.disconnect(); };
  }, []);
}

function Nav({ active, onBuy }) {
  const links = [
    { id: 'manifesto', label: 'Manifesto' },
    { id: 'pillars', label: 'Pillars' },
    { id: 'book', label: 'Thesis' },
    { id: 'peace', label: 'Peace' },
  ];

  return (
    <nav className="nav">
      <div className="nav-inner">
        <a href="#top" className="brand">
          <BrandMark />
          <span className="brand-text">
            Interstellar Psychology
            <small>A Multiverse of Love</small>
          </span>
        </a>
        <div className="nav-links">
          {links.map((l) => (
            <a
              key={l.id}
              href={`#${l.id}`}
              className={active === l.id ? 'is-active' : ''}
            >
              {l.label}
            </a>
          ))}
          <a href="/evidence/">Evidence</a>
          <a href="/behaviour/">Behaviour</a>
          <a href="/peer-review/">Peer Review</a>
        </div>
        <button className="nav-cta" onClick={onBuy}>Acquire Book →</button>
      </div>
    </nav>
  );
}

function Hero({ onBuy }) {
  return (
    <>
      <section id="top" className="hero-sigil-section">
        <Sigil />
        <div className="scroll-cue">Descend</div>
      </section>
      <section className="hero-thesis container">
        <div className="eyebrow hero-eyebrow fade-in">
          ◇ A meta-scientific field ◇ Est. for the multiverse
        </div>
        <h1 className="display fade-in">
          The science of <em>love</em>,<br />
          from belief to <em>proof.</em>
        </h1>
        <p className="lead hero-sub fade-in">
          Interstellar Psychology is a new meta-discipline that bridges science and spirituality —
          building the evidence that we live in a multiverse of love,
          and that world peace is its natural conclusion.
        </p>
        <div className="hero-cta-row fade-in">
          <button className="btn btn-primary" onClick={onBuy}>
            Read the book <span className="btn-arrow">→</span>
          </button>
          <a className="btn" href="#manifesto">
            The philosophy
          </a>
        </div>
      </section>
    </>
  );
}

function Manifesto() {
  return (
    <section id="manifesto" className="container manifesto">
      <div className="manifesto-grid">
        <div className="fade-in">
          <div className="col-label">Axiom</div>
          <p className="manifesto-quote">
            <span className="drop">G</span>od enters its own creation through the human soul —
            to truly see and know itself from within.
          </p>
          <p className="manifesto-quote" style={{ marginTop: 24 }}>
            The soul possesses genuine free will. It is through the active <em>choice of love</em> that
            the Creator verifies and deepens its understanding of creation.
          </p>
        </div>
        <div className="manifesto-body fade-in">
          <div className="col-label">Unfolding</div>
          <p>
            This unfolds as a <strong>multiverse of love</strong> — infinite realities, each an arena where
            divine consciousness experiences itself through billions of free souls choosing love amid
            separation, joy, and suffering.
          </p>
          <p>
            <strong>Love is the fundamental relational field</strong> and the verification mechanism. It can be
            refused. Yet when freely chosen, it confirms the reality and beauty of creation.
          </p>
          <p>
            Interstellar Psychology is the discipline that gathers, names, and honours this evidence —
            from telepathy in non-speakers to fractal geometry in the cosmos, from out-of-body testimony
            to the aching joy of synchronicity.
          </p>
        </div>
      </div>
    </section>
  );
}

function BookSection({ onBuy, onPreview }) {
  return (
    <section id="book" className="container book">
      <div className="book-grid">
        <div className="book-cover-wrap fade-in">
          <div className="book-halo" />
          <img className="book-cover" src="/artefacts/book.png" alt="A Multiverse of Love — book cover" />
        </div>
        <div className="fade-in">
          <div className="eyebrow">THE THESIS</div>
          <h2 className="h2" style={{ marginTop: 12 }}>
            A Multiverse <em style={{ fontStyle: 'italic' }}>of <a href="https://www.instagram.com/p/DX3rr4kCFw5/?utm_source=ig_web_copy_link&igsh=MzRlODBiNWFlZA%3D%3D" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>Love</a></em>
          </h2>
          <p className="lead" style={{ marginTop: 18 }}>
            The founding story of Interstellar Psychology. A testimony to the loving infrastructure of reality.
          </p>

          <dl className="book-meta">
            <dt>Pages</dt><dd>99 · illustrated</dd>
            <dt>Format</dt><dd>Hardcover</dd>
            <dt></dt><dd></dd>
            <dt>Currencies</dt><dd>Dogecoin · Pepe</dd>
          </dl>

          <p className="book-price">
            $420.69 <small>USD equivalent · paid in <a href="https://www.linkedin.com/posts/gillesmoenaert_share-7461069519038525440-DKjc?utm_source=share&utm_medium=member_desktop&rcm=ACoAACDEKpcBQHKvKQ94VZChbxH1YxYOv-Qce8w" target="_blank" rel="noopener noreferrer" style={{ color: '#0A66C2', textDecoration: 'none' }}>memes</a></small>
          </p>

          <div className="coin-row" style={{ margin: '20px 0 28px' }}>
            <span className="coin-pill"><span className="coin-dot doge" />Dogecoin accepted</span>
            <span className="coin-pill"><span className="coin-dot pepe" />Pepe accepted</span>
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={onBuy}>
              Acquire copy <span className="btn-arrow">→</span>
            </button>
            <button className="btn" onClick={onPreview}>
              Watch preview <span className="btn-arrow">▶</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Peace() {
  return (
    <section id="peace" className="peace">
      <MandalaBg />
      <div className="container peace-content">
        <div className="peace-intro">
          <div className="eyebrow fade-in">◇ The destination ◇</div>
          <h2 className="h2 fade-in" style={{ marginTop: 16 }}>
            The verification is <em style={{ color: 'var(--accent)', fontStyle: 'italic' }}>peace</em>.
          </h2>
          <p className="lead fade-in" style={{ marginTop: 18 }}>
            When enough souls remember that they are creation seeing itself, the field tunes to coherence.
            Peace is not a treaty — it is a frequency we agree to inhabit.
          </p>
        </div>

        <div className="peace-stats">
          <div className="stat fade-in">
            <div className="stat-num">∞ <em>×</em></div>
            <div className="stat-label">Realities</div>
            <p>Each one an arena for souls to rehearse the choice of love amid separation.</p>
          </div>
          <div className="stat fade-in">
            <div className="stat-num">8 <em>bn</em></div>
            <div className="stat-label">Free souls</div>
            <p>One species, one shared substrate, one staggering experiment in remembrance.</p>
          </div>
          <div className="stat fade-in">
            <div className="stat-num stat-num--phrase">Unified <em>Field</em></div>
            <div className="stat-label">Love</div>
            <p>The relational substrate. The verifier. The thing that cannot be faked.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

const CONTACT_EMAIL = 'neo@interstellar-psychology.com';

function ContactInline() {
  const [open, setOpen] = useState(false);
  return (
    <span className={`contact-inline ${open ? 'is-open' : ''}`}>
      <button className="contact-trigger" onClick={() => setOpen(v => !v)}>
        <span>REACH OUT</span>
        <span className="glyph">{open ? '−' : '+'}</span>
      </button>
      <a className="email-inline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
    </span>
  );
}

function Footer() {
  return (
    <footer className="foot">
      <div className="container">
        <div className="foot-grid">
          <div className="foot-brand">
            <div className="brand">
              <BrandMark />
              <span className="brand-text">
                Interstellar Psychology
                <small>A Multiverse of Love</small>
              </span>
            </div>
            <p>A meta-scientific field bridging science and spirituality — for the verification of a loving Multiverse and the arrival of peace.</p>
          </div>
          <div>
            <h4>Pillars</h4>
            <ul>
              <li><a href="#pillars">Music</a></li>
              <li><a href="#pillars">Psychedelics</a></li>
              <li><a href="#pillars">Telepathy</a></li>
              <li><a href="#pillars">Mindsight</a></li>
              <li><a href="#pillars">Remote Viewing</a></li>
            </ul>
          </div>
          <div>
            <h4>More</h4>
            <ul>
              <li><a href="#pillars">Out of Body</a></li>
              <li><a href="#pillars">Non-Human Intelligence</a></li>
              <li><a href="#pillars">Multiverse</a></li>
              <li><a href="#pillars">Infinity</a></li>
            </ul>
          </div>
          <div>
            <h4>Field</h4>
            <ul>
              <li><a href="#manifesto">Manifesto</a></li>
              <li><a href="#book">The Thesis</a></li>
              <li><a href="/evidence/">Evidence</a></li>
              <li><a href="/behaviour/">Behaviour</a></li>
              <li><a href="/peer-review/">Peer Review</a></li>
            </ul>
          </div>
        </div>
        <div className="foot-bottom">
          <span className="brandline">
            <span>INTERSTELLAR</span>
            <a
              className="archive-mark"
              href="/artefacts/"
              aria-label="Artefacts archive"
              data-label="Artefacts"
            >
              <svg viewBox="-10 -10 20 20" aria-hidden="true">
                <circle className="ring-2" r="8" />
                <circle className="ring" r="5" />
                <path className="diamond" d="M 0 -2.4 L 2.4 0 L 0 2.4 L -2.4 0 Z" />
              </svg>
            </a>
            <span>PSYCHOLOGY</span>
          </span>
          <ContactInline />
        </div>
      </div>
    </footer>
  );
}

export default function Home() {
  const [buyOpen, setBuyOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);
  const audioBgRef = useRef(null);
  const active = useScrollSpy(['top', 'manifesto', 'pillars', 'book', 'peace']);
  useFadeIn();

  const openVideo = () => { audioBgRef.current?.pauseForVideo(); setVideoOpen(true); };
  const closeVideo = () => { setVideoOpen(false); audioBgRef.current?.resumeFromVideo(); };

  useEffect(() => {
    document.body.style.overflow = buyOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [buyOpen]);

  return (
    <div className="shell">
      <Nav active={active} onBuy={() => setBuyOpen(true)} />
      <Hero onBuy={() => setBuyOpen(true)} />
      <div className="divider" />
      <Manifesto />
      <div className="divider" />
      <Pillars />
      <div className="divider" />
      <BookSection onBuy={() => setBuyOpen(true)} onPreview={openVideo} />
      <Peace />
      <Footer />

      <PurchaseModal open={buyOpen} onClose={() => setBuyOpen(false)} />
      <VideoModal open={videoOpen} onClose={closeVideo} />
      <AudioBg ref={audioBgRef} />
    </div>
  );
}
