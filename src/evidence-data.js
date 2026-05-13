import { useState, useEffect } from 'react';
import { supabase } from './lib/supabase';

export const PILLARS = [
  { n: "01", id: "music",                  title: "Music",                  tag: "Frequency · Soul",    blurb: "Sound as the first language of the multiverse. The harmonic substrate that lets souls recognise each other." },
  { n: "02", id: "psychedelics",           title: "Psychedelics",           tag: "Healing · Truth",     blurb: "Compounds that lift the veil. Reproducible mystical experience under controlled conditions." },
  { n: "03", id: "telepathy",              title: "Telepathy",              tag: "Mind-to-mind",        blurb: "The hardest case to ignore — non-speaking autistics doing the impossible, on camera, repeatedly." },
  { n: "04", id: "mindsight",              title: "Mindsight",              tag: "Inner perception",    blurb: "Seeing without eyes. Children trained to read text and identify colours while fully blindfolded." },
  { n: "05", id: "remote-viewing",         title: "Remote Viewing",         tag: "Non-local sight",     blurb: "Twenty-three years of CIA research. Declassified. The documents are not in dispute." },
  { n: "06", id: "out-of-body",            title: "Out of Body",            tag: "Soul travel",         blurb: "Cardiac arrest survivors describing the operating room from the ceiling. The data is now boring." },
  { n: "07", id: "non-human-intelligence", title: "Non-Human Intelligence", tag: "Disclosure",          blurb: "From AAWSAP to congressional testimony — the question is no longer whether, but how we relate." },
  { n: "08", id: "multiverse",             title: "Multiverse",             tag: "Infinite arenas",     blurb: "Synchronicity as evidence. The universe signalling that it sees you." },
  { n: "09", id: "infinity",               title: "Infinity",               tag: "Fractal · Eternal",   blurb: "Self-similar, scale-invariant, endless. The fractal thumbprint of God." },
];

const PILLAR_MAP = Object.fromEntries(PILLARS.map(p => [p.id, p]));

function normalize(row) {
  const pillar = PILLAR_MAP[row.pillar_id] || {};
  return {
    ...row,
    pillarId:    row.pillar_id,
    pillarTitle: pillar.title || row.pillar_id,
    pillarNum:   pillar.n || '??',
  };
}

export function useEvidence() {
  const [evidence, setEvidence] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);

  useEffect(() => {
    supabase
      .from('evidence')
      .select('*')
      .eq('status', 'approved')
      .order('pillar_id')
      .then(({ data, error: err }) => {
        if (err) setError(err.message);
        else setEvidence((data || []).map(normalize));
        setLoading(false);
      });
  }, []);

  const addOptimistic = (item) =>
    setEvidence(prev => [...prev, normalize({ ...item, status: 'approved' })]);

  return { evidence, loading, error, addOptimistic };
}
