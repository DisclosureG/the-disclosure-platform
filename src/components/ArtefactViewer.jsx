import { useState, useEffect, useRef, useCallback } from 'react';

export const ARTEFACTS = {
  bitcoin: {
    id: 'bitcoin', kind: 'pdf',
    glyph: '₿',
    section: 'Blockchain',
    title: 'Bitcoin: A Peer-to-Peer Electronic Cash System',
    short: 'Bitcoin',
    author: 'Satoshi Nakamoto', year: '2008',
    meter: '9 pp.',
    file: '/artefacts/blockchain/Bitcoin.pdf',
  },
  ethereum: {
    id: 'ethereum', kind: 'pdf',
    glyph: 'Ξ',
    section: 'Blockchain',
    title: 'Ethereum: A Next-Generation Smart Contract & Decentralized Application Platform',
    short: 'Ethereum',
    author: 'Vitalik Buterin', year: '2014',
    meter: '36 pp.',
    file: '/artefacts/blockchain/Ethereum.pdf',
  },
  cia: { id: 'cia', kind: 'pdf', glyph: '◎', section: 'Remote Viewing', short: 'CIA RV Document', title: 'CIA: Stargate Remote Viewing Research', author: 'CIA', year: '1995', meter: 'PDF', file: '/artefacts/remote-viewing/CIA-RDP96-00789R002800180001-2.pdf' },
  neo: { id: 'neo', kind: 'audio', glyph: '♪', section: 'Music', short: 'Neo', title: 'Neo', author: 'Interstellar Press', year: '2025', meter: '', file: '/artefacts/music/Neo.mp3' },
  chart: { id: 'chart', kind: 'image', glyph: '◫', section: 'Psychedelics', short: 'Chart', title: 'Psychedelics Chart', author: 'Interstellar Press', year: '2025', meter: '', file: '/artefacts/psychedelics/chart.webp' },
  'psychedelic-art': { id: 'psychedelic-art', kind: 'image', glyph: '◫', section: 'Psychedelics', short: 'Psychedelic Art', title: 'Psychedelic Art', author: 'Interstellar Press', year: '2025', meter: '', file: '/artefacts/psychedelics/psychedelic-art.PNG' },
  dollar: { id: 'dollar', kind: 'image', glyph: '◫', section: 'Telepathy', short: 'Dollar', title: 'Dollar Bill', author: 'Interstellar Press', year: '2025', meter: '', file: '/artefacts/telepathy/dollar.jpg' },
  'albertus-magnus': { id: 'albertus-magnus', kind: 'image', glyph: '◫', section: 'Multiversum', short: 'Albertus Magnus', title: 'Albertus Magnus', author: 'Historical', year: 'c. 1250', meter: '', file: '/artefacts/multiversum/Albertus-Magnus.jpg' },
  einstein: { id: 'einstein', kind: 'image', glyph: '◫', section: 'Multiversum', short: 'Einstein', title: 'Einstein', author: 'Historical', year: 'c. 1950', meter: '', file: '/artefacts/multiversum/Einstein.jpg' },
  enlightenment: { id: 'enlightenment', kind: 'image', glyph: '◫', section: 'Multiversum', short: 'Enlightenment', title: 'Enlightenment', author: 'Interstellar Press', year: '2025', meter: '', file: '/artefacts/multiversum/Enlightenment.png' },
  god: { id: 'god', kind: 'image', glyph: '◫', section: 'Multiversum', short: 'God', title: 'God', author: 'Interstellar Press', year: '2025', meter: '', file: '/artefacts/multiversum/God.JPG' },
  thirdeye: { id: 'thirdeye', kind: 'image', glyph: '◫', section: 'Multiversum', short: 'Third Eye', title: 'Third Eye', author: 'Interstellar Press', year: '2025', meter: '', file: '/artefacts/multiversum/thirdeye.jpg' },
  mysterie: { id: 'mysterie', kind: 'image', glyph: '◫', section: 'Multiversum', short: 'Mysterie', title: 'Mysterie · Ruimte · Vrede', author: 'Interstellar Press', year: '2025', meter: '', file: '/artefacts/multiversum/mysterie-ruimte-vrede.jpg' },
  'curt-jaimungal': { id: 'curt-jaimungal', kind: 'video', glyph: '▶', section: 'Multiversum', short: 'Curt Jaimungal', title: 'Maybe the crazy ones aren\'t crazy', author: 'Curt Jaimungal', year: '2023', meter: '', file: '/artefacts/multiversum/Curt Jaimungal - "Maybe the crazy ones aren\'t crazy".mp4' },
  'transcendental-meditation': { id: 'transcendental-meditation', kind: 'video', glyph: '▶', section: 'Infinity', short: 'Transcendental Meditation', title: 'Transcendental Meditation', author: 'Maharishi', year: '1975', meter: '', file: '/artefacts/infinity/Transcendental-Meditation.mp4' },
};

const KIND_DEFS = {
  pdf:   { label: 'Paper', verb: 'Read',   eyebrow: 'The math' },
  audio: { label: 'Track', verb: 'Listen', eyebrow: 'The voice' },
  video: { label: 'Film',  verb: 'Watch',  eyebrow: 'The motion' },
  image: { label: 'Plate', verb: 'View',   eyebrow: 'The plate' },
};

function stripPrefix(title) {
  return title.replace(/^[^:]+:\s*/, '');
}

function formatTime(s) {
  if (!s || !isFinite(s)) return '0:00';
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

// ── PDF renderer ──────────────────────────────────────────────────

function PdfRenderer({ artefact, onMeta, registerNav }) {
  const readerRef = useRef(null);
  const pagesRef = useRef(null);
  const tokenRef = useRef(0);
  const [total, setTotal] = useState(0);
  const [current, setCurrent] = useState(1);

  useEffect(() => {
    onMeta({ counterLabel: 'Folio', current, total, progress: total ? (current / total) * 100 : 0 });
  }, [current, total, onMeta]);

  const scrollTo = useCallback((n) => {
    const el = readerRef.current;
    if (!el) return;
    const clamped = Math.max(1, Math.min(total || 1, n));
    const target = el.querySelector(`.pdf-page-slot:nth-child(${clamped})`);
    if (target) el.scrollTo({ top: target.offsetTop - 24, behavior: 'smooth' });
  }, [total]);

  useEffect(() => {
    registerNav({
      prev: () => scrollTo(current - 1),
      next: () => scrollTo(current + 1),
      first: () => scrollTo(1),
      last: () => scrollTo(total),
      canPrev: current > 1,
      canNext: current < total,
    });
  }, [current, total, scrollTo, registerNav]);

  useEffect(() => {
    const token = ++tokenRef.current;
    setTotal(0); setCurrent(1);
    const pagesEl = pagesRef.current;
    if (pagesEl) pagesEl.innerHTML = '';

    const run = async () => {
      let tries = 0;
      while (!window.pdfjsLib && tries++ < 50) await new Promise(r => setTimeout(r, 60));
      if (!window.pdfjsLib || token !== tokenRef.current) return;

      const pdf = await window.pdfjsLib.getDocument(artefact.file).promise;
      if (token !== tokenRef.current) return;
      setTotal(pdf.numPages);

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const targetW = Math.min(820, (readerRef.current?.clientWidth || 800) - 56);
      const wrappers = [];

      for (let i = 1; i <= pdf.numPages; i++) {
        const wrapper = document.createElement('div');
        wrapper.className = 'pdf-page';
        wrapper.dataset.page = String(i);
        wrapper.style.cssText = `width:${targetW}px;aspect-ratio:8.5/11`;

        const folio = document.createElement('div');
        folio.className = 'pdf-folio';
        folio.innerHTML = `<em>${i}</em> &middot; ${pdf.numPages}`;

        const slot = document.createElement('div');
        slot.className = 'pdf-page-slot';
        slot.appendChild(wrapper);
        slot.appendChild(folio);
        pagesEl.appendChild(slot);
        wrappers.push({ wrapper, i });
      }

      for (const { wrapper, i } of wrappers) {
        if (token !== tokenRef.current) return;
        const page = await pdf.getPage(i);
        const vp0 = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: targetW / vp0.width });

        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.cssText = `width:${viewport.width}px;height:${viewport.height}px`;

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        wrapper.style.cssText = `width:${viewport.width}px;height:${viewport.height}px`;
        wrapper.appendChild(canvas);
        await page.render({ canvasContext: ctx, viewport }).promise;
      }
    };
    run().catch(e => console.error('PDF render:', e));
    return () => { tokenRef.current++; };
  }, [artefact.file]);

  // scroll-spy
  useEffect(() => {
    const el = readerRef.current;
    if (!el) return;
    const onScroll = () => {
      const slots = el.querySelectorAll('.pdf-page-slot');
      if (!slots.length) return;
      const offset = el.getBoundingClientRect().top + 80;
      let cur = 1;
      slots.forEach((s, i) => { if (s.getBoundingClientRect().top <= offset) cur = i + 1; });
      setCurrent(c => c === cur ? c : cur);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="pdf-reader" ref={readerRef}>
      <div className="pdf-pages" ref={pagesRef} />
    </div>
  );
}

// ── Audio renderer ────────────────────────────────────────────────

function AudioRenderer({ artefact, onMeta, registerNav }) {
  const audioRef = useRef(null);
  const waveRef = useRef(null);
  const [peaks, setPeaks] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setPeaks(null); setError(null);
    (async () => {
      try {
        const res = await fetch(artefact.file);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const decoded = await ctx.decodeAudioData(buf);
        if (cancelled) return;
        const samples = decoded.getChannelData(0);
        const n = 600;
        const block = Math.max(1, Math.floor(samples.length / n));
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          let max = 0;
          for (let j = i * block, end = Math.min(j + block, samples.length); j < end; j++) {
            const v = Math.abs(samples[j]);
            if (v > max) max = v;
          }
          out[i] = max;
        }
        setPeaks(out);
        ctx.close();
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [artefact.file]);

  useEffect(() => {
    const canvas = waveRef.current;
    if (!canvas || !peaks) return;
    const draw = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = w * dpr; canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);
      const mid = h / 2, bw = w / peaks.length;
      const frac = duration ? time / duration : 0;
      for (let i = 0; i < peaks.length; i++) {
        const amp = peaks[i] * (h * 0.45);
        ctx.fillStyle = (i / peaks.length) < frac
          ? 'oklch(0.78 0.16 330)'
          : 'oklch(0.55 0.04 280 / 0.55)';
        ctx.fillRect(i * bw, mid - amp, Math.max(1, bw * 0.7), amp * 2);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [peaks, time, duration]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const handlers = {
      timeupdate: () => setTime(a.currentTime),
      loadedmetadata: () => setDuration(a.duration || 0),
      durationchange: () => setDuration(a.duration || 0),
      play: () => setPlaying(true),
      pause: () => setPlaying(false),
      ended: () => setPlaying(false),
    };
    Object.entries(handlers).forEach(([ev, fn]) => a.addEventListener(ev, fn));
    return () => Object.entries(handlers).forEach(([ev, fn]) => a.removeEventListener(ev, fn));
  }, [artefact.file]);

  useEffect(() => {
    onMeta({
      counterLabel: 'Time',
      currentLabel: formatTime(time),
      totalLabel: formatTime(duration),
      progress: duration ? (time / duration) * 100 : 0,
    });
  }, [time, duration, onMeta]);

  useEffect(() => {
    registerNav({
      icon: playing ? 'pause' : 'play',
      primary: () => { const a = audioRef.current; if (a) a.paused ? a.play() : a.pause(); },
      prev: () => { const a = audioRef.current; if (a) a.currentTime = Math.max(0, a.currentTime - 5); },
      next: () => { const a = audioRef.current; if (a) a.currentTime = Math.min(duration, a.currentTime + 5); },
      canPrev: true, canNext: true,
    });
  }, [playing, duration, registerNav]);

  const onSeek = (e) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    a.currentTime = Math.max(0, Math.min(duration, ((e.clientX - rect.left) / rect.width) * duration));
  };

  return (
    <div className="media-stage media-stage--audio">
      <div className="audio-card">
        <div className="audio-glyph">{artefact.glyph || '♪'}</div>
        <div className="audio-meta">
          <div className="audio-eyebrow">{KIND_DEFS.audio.eyebrow}</div>
          <h4 className="audio-title">{stripPrefix(artefact.title)}</h4>
          <div className="audio-byline">{artefact.author} · {artefact.year}</div>
        </div>
        <div className="audio-wave" onClick={onSeek} role="slider" aria-label="Seek">
          {!peaks && !error && <div className="audio-wave-shimmer" />}
          {error && <div className="audio-wave-err">No source · <code>{artefact.file}</code></div>}
          <canvas ref={waveRef} className="audio-wave-canvas" />
          {duration > 0 && <div className="audio-cursor" style={{ left: `${(time / duration) * 100}%` }} />}
        </div>
        <div className="audio-times">
          <span>{formatTime(time)}</span>
          <span>−{formatTime(Math.max(0, duration - time))}</span>
        </div>
        <audio ref={audioRef} src={artefact.file} preload="metadata" />
      </div>
    </div>
  );
}

// ── Video renderer ────────────────────────────────────────────────

function VideoRenderer({ artefact, onMeta, registerNav }) {
  const videoRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(false);

  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    const handlers = {
      timeupdate: () => setTime(v.currentTime),
      loadedmetadata: () => setDuration(v.duration || 0),
      play: () => setPlaying(true), pause: () => setPlaying(false), error: () => setError(true),
    };
    Object.entries(handlers).forEach(([ev, fn]) => v.addEventListener(ev, fn));
    return () => Object.entries(handlers).forEach(([ev, fn]) => v.removeEventListener(ev, fn));
  }, [artefact.file]);

  useEffect(() => {
    onMeta({ counterLabel: 'Time', currentLabel: formatTime(time), totalLabel: formatTime(duration), progress: duration ? (time / duration) * 100 : 0 });
  }, [time, duration, onMeta]);

  useEffect(() => {
    registerNav({
      icon: playing ? 'pause' : 'play',
      primary: () => { const v = videoRef.current; if (v) v.paused ? v.play().catch(() => {}) : v.pause(); },
      prev: () => { const v = videoRef.current; if (v) v.currentTime = Math.max(0, v.currentTime - 5); },
      next: () => { const v = videoRef.current; if (v) v.currentTime = Math.min(duration, v.currentTime + 5); },
      canPrev: true, canNext: true,
    });
  }, [playing, duration, registerNav]);

  const onSeek = (e) => {
    const v = videoRef.current; if (!v || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    v.currentTime = Math.max(0, Math.min(duration, ((e.clientX - rect.left) / rect.width) * duration));
  };

  return (
    <div className="media-stage media-stage--video">
      <div className="video-frame">
        {error ? (
          <div className="video-empty">
            <div className="video-empty-glyph">▶</div>
            <h4>No film to project.</h4>
            <p>Drop a video at <code>{artefact.file}</code>.</p>
          </div>
        ) : (
          <video ref={videoRef} src={artefact.file} className="video-el" playsInline />
        )}
        <div className="video-caption">
          <span>{artefact.short}.</span>
          <span className="video-caption-sub">{artefact.author} · {artefact.year}</span>
        </div>
      </div>
      {!error && duration > 0 && (
        <div className="video-scrub" onClick={onSeek}>
          <div className="video-scrub-fill" style={{ width: `${(time / duration) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

// ── Image renderer ────────────────────────────────────────────────

function ImageRenderer({ artefact, onMeta, registerNav }) {
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState(false);

  useEffect(() => {
    onMeta({ counterLabel: 'Zoom', currentLabel: `${Math.round(zoom * 100)}%`, totalLabel: artefact.meter || '', progress: ((zoom - 0.5) / 1.5) * 100 });
  }, [zoom, artefact.meter, onMeta]);

  useEffect(() => {
    registerNav({
      prev: () => setZoom(z => Math.max(0.5, +(z - 0.25).toFixed(2))),
      next: () => setZoom(z => Math.min(2, +(z + 0.25).toFixed(2))),
      canPrev: zoom > 0.5, canNext: zoom < 2,
    });
  }, [zoom, registerNav]);

  return (
    <div className="media-stage media-stage--image">
      <div className="image-frame" onClick={() => setZoom(z => (z >= 2 ? 1 : +(z + 0.5).toFixed(2)))}>
        {error ? (
          <div className="image-empty">
            <div className="image-empty-glyph">◫</div>
            <h4>No plate.</h4>
            <p>Drop an image at <code>{artefact.file}</code>.</p>
          </div>
        ) : (
          <img src={artefact.file} alt={artefact.title} className="image-el" style={{ transform: `scale(${zoom})` }} onError={() => setError(true)} />
        )}
      </div>
      {!error && <div className="image-caption"><em>{artefact.short}.</em> {artefact.title}</div>}
    </div>
  );
}

// ── Universal viewer modal ────────────────────────────────────────

export default function ArtefactViewer({ artefactId, onClose }) {
  const [meta, setMeta] = useState({});
  const [nav, setNav] = useState({});
  const onMeta = useCallback((m) => setMeta(m), []);
  const registerNav = useCallback((n) => setNav(n), []);

  const artefact = artefactId ? ARTEFACTS[artefactId] : null;

  useEffect(() => {
    setMeta({}); setNav({});
  }, [artefactId]);

  useEffect(() => {
    if (!artefact) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); onClose(); }
      if (e.key === ' ' && nav.primary) { e.preventDefault(); nav.primary(); }
      if ((e.key === 'ArrowRight' || e.key === 'ArrowDown') && nav.next) { e.preventDefault(); nav.next(); }
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowUp') && nav.prev) { e.preventDefault(); nav.prev(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [artefact, nav, onClose]);

  const def = artefact ? (KIND_DEFS[artefact.kind] || KIND_DEFS.pdf) : null;
  const Renderer =
    artefact?.kind === 'audio' ? AudioRenderer :
    artefact?.kind === 'video' ? VideoRenderer :
    artefact?.kind === 'image' ? ImageRenderer :
    PdfRenderer;

  return (
    <div
      className={`pdf-backdrop${artefact ? ' is-open' : ''}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {artefact && (
        <div className={`pdf-shell pdf-shell--${artefact.kind}`} role="dialog" aria-label={artefact.title}>
          <div className="pdf-head">
            <div className="pdf-head-meta">
              <div className="pdf-head-eyebrow">
                <span className="kind-pill">{def.label}</span>
                <span>{def.eyebrow}</span>
                <span className="dot" />
                <span>{artefact.author}</span>
                <span className="dot" />
                <span>{artefact.year}</span>
              </div>
              <h3 className="pdf-head-title">
                <em>{artefact.short}.</em> {stripPrefix(artefact.title)}
              </h3>
            </div>
            <div className="pdf-head-actions">
              <a className="pdf-btn" href={artefact.file} target="_blank" rel="noopener noreferrer">
                <span className="lbl">Raw file</span>
                <span>↗</span>
              </a>
              <button className="pdf-btn is-primary" onClick={onClose}>
                <span className="lbl">Close</span>
                <span>esc</span>
              </button>
            </div>
          </div>

          <Renderer artefact={artefact} onMeta={onMeta} registerNav={registerNav} />

          <div className="pdf-foot">
            <div className="pdf-foot-meta">
              <span>{meta.counterLabel || '—'}</span>
              <span>
                <b>{meta.currentLabel != null ? meta.currentLabel : (meta.current || 1)}</b>
                <span className="of"> / {meta.totalLabel != null ? meta.totalLabel : (meta.total || '…')}</span>
              </span>
            </div>
            <div className="pdf-progress">
              <div className="pdf-progress-fill" style={{ width: `${meta.progress || 0}%` }} />
            </div>
            <div className="pdf-nav">
              <button className="pdf-nav-btn" onClick={() => nav.prev?.()} disabled={!nav.canPrev} aria-label="Previous">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              {nav.primary && (
                <button className="pdf-nav-btn pdf-nav-btn--primary" onClick={() => nav.primary?.()} aria-label={nav.icon === 'pause' ? 'Pause' : 'Play'}>
                  {nav.icon === 'pause'
                    ? <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
                    : <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                  }
                </button>
              )}
              <button className="pdf-nav-btn" onClick={() => nav.next?.()} disabled={!nav.canNext} aria-label="Next">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Artefact index ────────────────────────────────────────────────

export function ArtefactIndex({ openArtefact }) {
  const list = Object.values(ARTEFACTS);
  const sections = {};
  for (const a of list) {
    const s = a.section || 'Other';
    (sections[s] = sections[s] || []).push(a);
  }

  return (
    <div className="artefact-index">
      <header className="ai-head">
        <div className="ai-eyebrow">The library</div>
        <h2 className="ai-title">Every artefact <em>behind</em> the promise.</h2>
        <p className="ai-lede">Papers, recordings, frames and plates — each one a piece of the math. Click any tile to open it.</p>
      </header>

      {Object.entries(sections).map(([section, items]) => (
        <section key={section} className="ai-section">
          <div className="ai-section-head">
            <span className="ai-section-title">{section}</span>
            <span className="ai-section-count">{items.length}</span>
            <span className="ai-section-rule" />
          </div>
          <div className="ai-grid">
            {items.map(a => (
              <button key={a.id} className={`ai-tile ai-tile--${a.kind}`} onClick={() => openArtefact(a.id)}>
                <div className="ai-tile-frame">
                  {a.kind === 'image'
                    ? <img src={a.file} alt="" onError={e => e.target.style.display = 'none'} />
                    : <div className="ai-tile-glyph">{a.glyph}</div>}
                  <div className="ai-tile-kind">{KIND_DEFS[a.kind]?.label || a.kind}</div>
                </div>
                <div className="ai-tile-meta">
                  <strong>{a.short}.</strong>
                  <small>{[a.author, a.year, a.meter].filter(Boolean).join(' · ')}</small>
                </div>
                <div className="ai-tile-action">{KIND_DEFS[a.kind]?.verb || 'Open'} ↗</div>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
