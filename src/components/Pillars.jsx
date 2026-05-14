import { useState, useEffect, useRef } from 'react';
import { usePillarCounts } from '../evidence-data';

const slug = (s) => s.toLowerCase().replace(/\s+/g, '-');
const EVIDENCE_BASE = '/evidence/';

const PILLARS = [
  {
    n: "01",
    title: "Music",
    tag: "Frequency · Soul",
    blurb: "Artists weave the divine into melody — bridges of sound to the source.",
    quote: "In every note, a reminder of love's boundless light, the universe's gentle rhythm.",
    body: "Music is the first language of the multiverse — a vibration that predates form. Through harmonic resonance the soul recognises itself in the other.",
    links: ["Imagine Dragons"],
  },
  {
    n: "02",
    title: "Psychedelics",
    tag: "Healing · Truth",
    blurb: "Substances that open you to the possibility everything you know is wrong.",
    quote: "They dissolve opinion structures and culturally laid down models of behaviour.",
    body: "Plant medicines and entheogens function as keys, not as escape. They reveal the architecture of consciousness from inside the architecture itself.",
    links: ["Consiousness","Afterlife", "Psychedelic Ascension"],
  },
  {
    n: "03",
    title: "Telepathy",
    tag: "Mind-to-mind",
    blurb: "Non-speakers with autism reveal abilities long dismissed as fantasy.",
    quote: "Love really hates when we choose money",
    body: "The Telepathy Tapes and decades of parapsychological research point to a substrate of consciousness where minds are not isolated islands.",
    links: ["The Telepathy Tapes", "Julia Mossbridge"],
  },
  {
    n: "04",
    title: "Mindsight",
    tag: "Inner perception",
    blurb: "Seeing without eyes",
    links: ["Third eye", "Energy", "Dalia Burgoin", "Mark Komissarov"],
  },
  {
    n: "05",
    title: "Remote Viewing",
    tag: "Non-local sight",
    blurb: "Declassified Stargate Project — the CIA's psychic intelligence program.",
    quote: "Distance is a property of matter, not of mind.",
    body: "Twenty-three years of US government research yielded statistically significant results that mainstream science has yet to integrate.",
    links: ["Stargate Project", "Ingo Swann", "Stanford"],
  },
  {
    n: "06",
    title: "Out of Body",
    tag: "Soul travel",
    blurb: "The Monroe Institute, NDEs, and the testable claim that you are not your body.",
    quote: "I left my body and found I was still entirely myself.",
    body: "Cardiac arrest survivors describe the operating room from the ceiling. Hemi-Sync practitioners chart the territory deliberately.",
    links: ["Monroe Institute", "Anthony Chene"],
  },
  {
    n: "07",
    title: "Non-Human Intelligence",
    tag: "Disclosure",
    blurb: "From AATIP to ancient testimony — we have never been alone.",
    quote: "The universe is not stranger than we suppose, but stranger than we can suppose.",
    body: "UAP disclosure, contactee reports, interdimensional hypotheses. The question is no longer whether — but how we relate.",
    links: ["AWSAP/AATIP", "David Grusch", "Ross Coulthart", "Steven Greer"],
    tagLink: "https://x.com/UapJunky",
  },
  {
    n: "08",
    title: "Multiverse",
    tag: "Infinite arenas",
    blurb: "Synchronicity as evidence — the universe is signalling that it sees you.",
    quote: "Coincidence is the multiverse's native vocabulary.",
    body: "The multiverse is the loving infrastructure that lets every soul rehearse the path home.",
    links: ["Carl Jung", "Synchronicity"],
  },
  {
    n: "09",
    title: "Infinity",
    tag: "Fractal · Eternal",
    blurb: "There is no end, only deeper layers of wonder.",
    quote: "The fractal thumbprint of God",
    body: "Sacred geometry and chaos mathematics describe the same structure: a creation that contains itself at every scale.",
    links: ["Mandelbrot", "Free will", "Flower of life"],
  },
];

function PillarCard({ p, isOpen, onToggle, idx }) {
  const ref = useRef(null);
  const [animating, setAnimating] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDone(true);
      return;
    }
    const io = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setAnimating(true); io.disconnect(); }
    }, { threshold: 0.12 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const animClass = done ? '' : animating ? ' pillar-entering' : ' pillar-hidden';
  const evidenceHref = `${EVIDENCE_BASE}#${slug(p.title)}`;

  return (
    <article
      ref={ref}
      className={`pillar${animClass}${isOpen ? ' is-open' : ''}`}
      onClick={onToggle}
      style={animating && !done ? { animationDelay: `${idx * 30}ms` } : {}}
      onAnimationEnd={animating && !done ? () => setDone(true) : undefined}
      data-pillar={p.title.toLowerCase()}
    >
      <div className="pillar-num">
        <span>{p.n} / 09</span>
        <svg className="glyph" viewBox="-12 -12 24 24" aria-hidden="true">
          <circle r="10" fill="none" stroke="currentColor" strokeOpacity="0.4" />
          <line x1="-6" y1="0" x2="6" y2="0" stroke="currentColor" strokeOpacity="0.7" />
          <line x1="0" y1="-6" x2="0" y2="6" stroke="currentColor" strokeOpacity={isOpen ? 0 : 0.7} />
        </svg>
      </div>
      {p.tagLink ? (
        <a
          className="pillar-tag"
          href={p.tagLink}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
        >{p.tag}</a>
      ) : (
        <div className="pillar-tag">{p.tag}</div>
      )}
      <h3 className="pillar-title">{p.title}</h3>
      <p className="pillar-blurb">{p.blurb}</p>

      <div className="pillar-detail">
        {p.quote && <p className="quote">&ldquo;{p.quote}&rdquo;</p>}
        <p>{p.body}</p>
        <div className="links">
          {p.links.map((l) => (
            <a key={l} href="#" onClick={(e) => e.preventDefault()}>{l}</a>
          ))}
        </div>

        <a
          className="pillar-evidence-link"
          href={evidenceHref}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="ev-rule" />
          <span className="ev-label">Evidence</span>
          {p.evidenceCount && <span className="ev-count">· {p.evidenceCount} entries</span>}
          <span className="ev-arrow">↗</span>
        </a>
      </div>

      <a
        className="pillar-evidence-foot"
        href={evidenceHref}
        onClick={(e) => e.stopPropagation()}
        aria-label={`See evidence for ${p.title}`}
      >
        <span>Evidence</span>
        {p.evidenceCount && <span className="ev-count">· {p.evidenceCount}</span>}
        <span className="ev-arrow">↗</span>
      </a>
    </article>
  );
}

export default function Pillars() {
  const [open, setOpen] = useState(null);
  const counts = usePillarCounts();
  return (
    <section id="pillars" className="container">
      <div className="pillars-head fade-in">
        <div>
          <div className="eyebrow">Curriculum · Nine pillars</div>
          <h2 className="h2" style={{ marginTop: 16 }}>
            A doctorate <em style={{ fontStyle: 'italic', color: 'var(--accent)' }}>in love</em>,<br />
            taught by the cosmos.
          </h2>
        </div>
        <p className="lead">
          Each pillar is a discipline where science and spirituality are already converging — quietly, often dismissed,
          increasingly undeniable. Tap any to descend.
        </p>
      </div>

      <div className="pillars-grid">
        {PILLARS.map((p, i) => (
          <PillarCard
            key={p.title}
            p={{ ...p, evidenceCount: counts[slug(p.title)] }}
            idx={i}
            isOpen={open === i}
            onToggle={() => setOpen(open === i ? null : i)}
          />
        ))}
      </div>
    </section>
  );
}
