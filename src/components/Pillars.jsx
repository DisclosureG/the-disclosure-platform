import { useState, useEffect, useRef } from 'react';

const PILLARS = [
  {
    n: "01",
    title: "Music",
    tag: "Frequency · Soul",
    blurb: "Artists weave the divine into melody — bridges of sound to the source.",
    quote: "In every note, a reminder of love's boundless light, the universe's gentle rhythm.",
    body: "Music is the first language of the multiverse — a vibration that predates form. Through harmonic resonance the soul recognises itself in the other.",
    links: ["Frequency 432Hz", "Sacred chant", "Cosmic resonance"]
  },
  {
    n: "02",
    title: "Psychedelics",
    tag: "Dissolution · Sight",
    blurb: "Substances that open you to the possibility everything you know is wrong.",
    quote: "They dissolve opinion structures and culturally laid down models of behaviour. — Terence McKenna",
    body: "Plant medicines and entheogens function as keys, not as escape. They reveal the architecture of consciousness from inside the architecture itself.",
    links: ["DMT", "Psilocybin", "Ayahuasca", "Set & setting"]
  },
  {
    n: "03",
    title: "Telepathy",
    tag: "Mind-to-mind",
    blurb: "Non-speakers with autism reveal abilities long dismissed as fantasy.",
    quote: "What if the limits of language were never the limits of knowing?",
    body: "The Telepathy Tapes and decades of parapsychological research point to a substrate of consciousness where minds are not isolated islands.",
    links: ["The Telepathy Tapes", "Ganzfeld experiments", "Twin studies"]
  },
  {
    n: "04",
    title: "Mindsight",
    tag: "Inner perception",
    blurb: "Seeing without eyes — the trained capacity to perceive interior worlds.",
    quote: "The cave you fear to enter holds the treasure you seek.",
    body: "Children taught to read with blindfolds, contemplatives mapping the inner sky. Mindsight is the missing curriculum of attention.",
    links: ["Daniel Siegel", "Blindsight", "Internal Family Systems"]
  },
  {
    n: "05",
    title: "Remote Viewing",
    tag: "Non-local sight",
    blurb: "Declassified Stargate Project — the CIA's psychic intelligence program.",
    quote: "Distance is a property of matter, not of mind.",
    body: "Twenty-three years of US government research yielded statistically significant results that mainstream science has yet to integrate.",
    links: ["Stargate Project", "Ingo Swann", "SRI protocols"]
  },
  {
    n: "06",
    title: "Out of Body",
    tag: "Soul travel",
    blurb: "The Monroe Institute, NDEs, and the testable claim that you are not your body.",
    quote: "I left my body and found I was still entirely myself.",
    body: "Cardiac arrest survivors describe the operating room from the ceiling. Hemi-Sync practitioners chart the territory deliberately.",
    links: ["Robert Monroe", "Pim van Lommel", "Hemi-Sync"]
  },
  {
    n: "07",
    title: "Non-Human Intelligence",
    tag: "Contact · Other",
    blurb: "From AATIP to ancient testimony — we have never been alone.",
    quote: "The universe is not stranger than we suppose, but stranger than we can suppose.",
    body: "UAP disclosure, contactee reports, interdimensional hypotheses. The question is no longer whether — but how we relate.",
    links: ["AATIP / AARO", "Coulthart", "Vallée"]
  },
  {
    n: "08",
    title: "Multiverse",
    tag: "Infinite arenas",
    blurb: "Synchronicity as evidence — the universe is signalling that it sees you.",
    quote: "Coincidence is the multiverse's native vocabulary.",
    body: "Every choice branches a world. The multiverse is the loving infrastructure that lets every soul rehearse the path home.",
    links: ["Carl Jung", "Hugh Everett", "Synchronicity"]
  },
  {
    n: "09",
    title: "Infinity",
    tag: "Fractal · Eternal",
    blurb: "The fractal thumbprint of God — Mandelbrot's cathedral of recursion.",
    quote: "There is no end, only deeper layers of wonder.",
    body: "Sacred geometry and chaos mathematics describe the same structure: a creation that contains itself at every scale.",
    links: ["Mandelbrot set", "Flower of life", "Phi spiral"]
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
      <div className="pillar-tag">{p.tag}</div>
      <h3 className="pillar-title">{p.title}</h3>
      <p className="pillar-blurb">{p.blurb}</p>
      <div className="pillar-detail">
        <p className="quote">&ldquo;{p.quote}&rdquo;</p>
        <p>{p.body}</p>
        <div className="links">
          {p.links.map((l) => (
            <a key={l} href="#" onClick={(e) => e.preventDefault()}>{l}</a>
          ))}
        </div>
      </div>
    </article>
  );
}

export default function Pillars() {
  const [open, setOpen] = useState(null);
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
          Each pillar is a discipline where science and spirit are already converging — quietly, often dismissed,
          increasingly undeniable. Tap any to descend.
        </p>
      </div>

      <div className="pillars-grid">
        {PILLARS.map((p, i) => (
          <PillarCard
            key={p.title}
            p={p}
            idx={i}
            isOpen={open === i}
            onToggle={() => setOpen(open === i ? null : i)}
          />
        ))}
      </div>
    </section>
  );
}
