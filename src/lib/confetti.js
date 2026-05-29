// One-shot confetti burst for genuine wins only — evidence filed, a vote signed,
// a proposal confirmed. Warm pastel palette from the "Daylight" system
// (tour-video/src/theme.ts). Self-contained: appends a fixed layer, animates via
// the Web Animations API, and removes itself ~1.7s later. No React wiring.
// Skipped entirely under prefers-reduced-motion, per the project's a11y rule.
const PALETTE = ['#D97757', '#6CA8CF', '#6FAE8E', '#E6B454', '#A38BD1', '#E8917B'];

export function fireConfetti({ count = 42, originX = 0.5, originY = 0.4 } = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (!Element.prototype.animate) return; // graceful no-op on very old engines

  const layer = document.createElement('div');
  layer.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:9998;overflow:hidden;';
  document.body.appendChild(layer);

  const W = window.innerWidth;
  const H = window.innerHeight;
  const cx = originX * W;
  const cy = originY * H;

  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    const size = 8 + Math.random() * 12;
    const round = Math.random() > 0.5;
    const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    p.style.cssText =
      `position:absolute;left:${cx}px;top:${cy}px;width:${size}px;` +
      `height:${round ? size : size * 0.5}px;border-radius:${round ? '50%' : '3px'};` +
      `background:${color};will-change:transform,opacity;`;
    layer.appendChild(p);

    const angle = ((-90 + (Math.random() - 0.5) * 150) * Math.PI) / 180;
    const dist = 120 + Math.random() * 260;
    const dx = Math.cos(angle) * dist;
    const dyUp = Math.sin(angle) * dist;
    const dyDown = dyUp + 320 + Math.random() * 220; // gravity drift down
    const rot = Math.random() * 720 - 360;
    const dur = 1100 + Math.random() * 500;

    p.animate(
      [
        { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
        {
          transform: `translate(${dx * 0.5}px, ${dyUp}px) rotate(${rot * 0.5}deg)`,
          opacity: 1,
          offset: 0.45,
        },
        { transform: `translate(${dx}px, ${dyDown}px) rotate(${rot}deg)`, opacity: 0 },
      ],
      { duration: dur, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)', fill: 'forwards' }
    );
  }

  setTimeout(() => layer.remove(), 1700);
}
