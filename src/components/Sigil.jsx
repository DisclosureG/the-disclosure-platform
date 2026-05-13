import { useEffect, useRef } from 'react';

function MandelbrotCanvas() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const dpr = 1;
    const size = 380;
    cvs.width = size * dpr;
    cvs.height = size * dpr;
    const ctx = cvs.getContext('2d');
    const W = cvs.width, H = cvs.height;
    const img = ctx.createImageData(W, H);
    const data = img.data;

    const root = getComputedStyle(document.documentElement);
    const accent = root.getPropertyValue('--accent').trim() || 'oklch(0.78 0.16 330)';
    const hueMatch = accent.match(/oklch\([^)]*\s+([\d.]+)\s*\/?/);
    const hue = hueMatch ? parseFloat(hueMatch[1].split(' ').pop()) : 330;

    let raf;
    let phase = 0;
    const reduced = document.body.classList.contains('reduced-motion');

    const render = () => {
      const t = phase;
      const zoom = 1.6 + Math.sin(t * 0.15) * 0.25;
      const cx = -0.745 + Math.cos(t * 0.08) * 0.04;
      const cy = 0.105 + Math.sin(t * 0.10) * 0.03;
      const maxIter = 48;

      for (let py = 0; py < H; py++) {
        for (let px = 0; px < W; px++) {
          const x0 = (px / W - 0.5) * (3.0 / zoom) + cx;
          const y0 = (py / H - 0.5) * (3.0 / zoom) + cy;
          let x = 0, y = 0, i = 0;
          while (x * x + y * y <= 4 && i < maxIter) {
            const xt = x * x - y * y + x0;
            y = 2 * x * y + y0;
            x = xt;
            i++;
          }
          const idx = (py * W + px) * 4;
          if (i === maxIter) {
            data[idx] = 0; data[idx+1] = 0; data[idx+2] = 0; data[idx+3] = 0;
          } else {
            const log_zn = Math.log(x*x + y*y) / 2;
            const nu = Math.log(log_zn / Math.log(2)) / Math.log(2);
            const v = (i + 1 - nu) / maxIter;
            const dx = px / W - 0.5, dy = py / H - 0.5;
            const r = Math.sqrt(dx*dx + dy*dy) * 2;
            const vignette = Math.max(0, 1 - r * 1.1);
            const lightness = 30 + v * 55;
            const sat = 35 + v * 25;
            const h = (hue + v * 40) % 360;
            const a = Math.round(vignette * (1 - v) * 220);
            const c = (1 - Math.abs(2 * (lightness/100) - 1)) * (sat/100);
            const hp = h / 60;
            const xCol = c * (1 - Math.abs(hp % 2 - 1));
            let r1=0,g1=0,b1=0;
            if (hp < 1) { r1=c; g1=xCol; b1=0; }
            else if (hp < 2) { r1=xCol; g1=c; b1=0; }
            else if (hp < 3) { r1=0; g1=c; b1=xCol; }
            else if (hp < 4) { r1=0; g1=xCol; b1=c; }
            else if (hp < 5) { r1=xCol; g1=0; b1=c; }
            else { r1=c; g1=0; b1=xCol; }
            const m = lightness/100 - c/2;
            data[idx]   = Math.round((r1 + m) * 255);
            data[idx+1] = Math.round((g1 + m) * 255);
            data[idx+2] = Math.round((b1 + m) * 255);
            data[idx+3] = a;
          }
        }
      }
      ctx.putImageData(img, 0, 0);
    };

    render();
    if (!reduced) {
      let last = performance.now();
      const FRAME_MS = 1000 / 15;
      const tick = (now) => {
        raf = requestAnimationFrame(tick);
        if (now - last < FRAME_MS) return;
        phase += ((now - last) / 1000) * 0.4;
        last = now;
        render();
      };
      raf = requestAnimationFrame(tick);
    }
    return () => raf && cancelAnimationFrame(raf);
  }, []);

  return <canvas ref={canvasRef} className="mandelbrot-bg" aria-hidden="true" />;
}

export function Sigil() {
  return (
    <div className="hero-sigil" aria-hidden="true">
      <div className="heart-frame">
        <MandelbrotCanvas />
      </div>
      <svg viewBox="-200 -200 400 400" xmlns="http://www.w3.org/2000/svg" className="sigil-svg">
        <defs>
          <radialGradient id="iris-grad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--bg-deep)" />
            <stop offset="55%" stopColor="var(--accent)" stopOpacity="0.85" />
            <stop offset="100%" stopColor="var(--accent-2)" stopOpacity="0.0" />
          </radialGradient>
          <radialGradient id="pupil-grad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--bg-deep)" />
            <stop offset="100%" stopColor="var(--bg)" />
          </radialGradient>
        </defs>

        <g>
          <path
            d="M -88 0 Q 0 -62 88 0 Q 0 62 -88 0 Z"
            fill="var(--bg-deep)"
            stroke="var(--ink-soft)"
            strokeOpacity="0.7"
            strokeWidth="1.2"
          />
          <g className="iris">
            <circle r="44" fill="url(#iris-grad)" />
            <circle r="44" fill="none" stroke="var(--accent)" strokeOpacity="0.6" strokeWidth="0.6" />
            {Array.from({ length: 36 }).map((_, i) => {
              const a = (i / 36) * Math.PI * 2;
              return (
                <line
                  key={i}
                  x1={Math.cos(a) * 14}
                  y1={Math.sin(a) * 14}
                  x2={Math.cos(a) * 42}
                  y2={Math.sin(a) * 42}
                  stroke="var(--accent)"
                  strokeOpacity={i % 3 === 0 ? 0.5 : 0.18}
                  strokeWidth="0.6"
                />
              );
            })}
            <circle r="16" fill="url(#pupil-grad)" />
            <circle r="16" fill="none" stroke="var(--ink)" strokeOpacity="0.5" strokeWidth="0.5" />
            <circle cx="-5" cy="-5" r="3" fill="var(--ink)" opacity="0.7" />
          </g>
        </g>
      </svg>
    </div>
  );
}

export function MandalaBg() {
  const R = 40;
  const points = [];
  for (let q = -2; q <= 2; q++) {
    for (let r = -2; r <= 2; r++) {
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= 2) {
        points.push([R * (q + r / 2), R * (r * Math.sqrt(3) / 2)]);
      }
    }
  }
  return (
    <svg className="peace-mandala" viewBox="-200 -200 400 400" aria-hidden="true">
      <g>
        {points.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={R} fill="none" stroke="currentColor" strokeWidth="0.6" />
        ))}
        <circle r={R * 3} fill="none" stroke="currentColor" strokeWidth="0.6" />
      </g>
    </svg>
  );
}

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="-50 -50 100 100" aria-hidden="true">
      <circle r="46" fill="none" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1" />
      <path
        d="M -32 0 Q 0 -22 32 0 Q 0 22 -32 0 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <circle r="11" fill="none" stroke="var(--accent)" strokeWidth="1.2" />
      <circle r="3" fill="var(--accent)" />
    </svg>
  );
}
