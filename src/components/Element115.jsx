import { useMemo } from 'react';

/**
 * Bohr-model atom of Element 115 (Moscovium / Mc).
 *   Z = 115 protons · A = 290 → N = 175 neutrons · 115 electrons
 *   Shell occupancy K–L–M–N–O–P–Q = 2, 8, 18, 32, 32, 18, 5
 * Each shell rotates at its own period/direction (animation in shared.css,
 * `.atom-115`), carrying its electrons around the nucleus.
 * Ported from the design bundle's element-115.js.
 */
const SHELLS = [
  { name: 'K', n: 2,  inset: 7,  period: 14, dir:  1 },
  { name: 'L', n: 8,  inset: 14, period: 22, dir: -1 },
  { name: 'M', n: 18, inset: 21, period: 32, dir:  1 },
  { name: 'N', n: 32, inset: 28, period: 44, dir: -1 },
  { name: 'O', n: 32, inset: 35, period: 58, dir:  1 },
  { name: 'P', n: 18, inset: 42, period: 76, dir: -1 },
  { name: 'Q', n: 5,  inset: 47, period: 96, dir:  1 }, // valence
];

const SIZE_CFG = {
  full: { electron: 6, nucleonDots: 64, nucleonSize: 3.5, nucleus: 18 },
  mid:  { electron: 4, nucleonDots: 44, nucleonSize: 3.0, nucleus: 19 },
  mini: { electron: 3, nucleonDots: 28, nucleonSize: 2.4, nucleus: 22 },
};

// Sunflower-pack a disc, mark first ~Z/290 as protons, deterministically shuffled
// so protons + neutrons interleave like a real nucleus.
function packNucleons(count, Z) {
  const phi = (1 + Math.sqrt(5)) / 2;
  const pts = [];
  for (let k = 0; k < count; k++) {
    const r = Math.sqrt((k + 0.5) / count) * 44;
    const theta = (k * 2 * Math.PI) / (phi * phi);
    pts.push({ x: 50 + r * Math.cos(theta), y: 50 + r * Math.sin(theta), idx: k });
  }
  pts.sort((a, b) => ((a.idx * 2654435761) % 1000) - ((b.idx * 2654435761) % 1000));
  pts.forEach((p, i) => { p.proton = i < Math.round((count * Z) / 290); });
  return pts;
}

export default function Element115({ size = 'full', plate = false, legend = false, shellLabels = false }) {
  const cfg = SIZE_CFG[size] || SIZE_CFG.full;
  const nucleons = useMemo(() => packNucleons(cfg.nucleonDots, 115), [cfg.nucleonDots]);

  return (
    <div
      className={`atom-115`}
      data-atom-size={size}
      aria-label="Element 115 · Moscovium · 115 protons, 175 neutrons, 115 electrons"
    >
      {SHELLS.map((shell, i) => (
        <div
          key={shell.name}
          className={`atom-shell s${i + 1}`}
          style={{
            inset: `${shell.inset}%`,
            animationDuration: `${shell.period}s`,
            animationDirection: shell.dir < 0 ? 'reverse' : undefined,
          }}
        >
          {shellLabels && <span className="atom-shell-label">{shell.name}·{shell.n}</span>}
          {Array.from({ length: shell.n }, (_, k) => {
            const angle = (k * 360) / shell.n + i * 7;
            return (
              <div key={k} className="atom-arm" style={{ transform: `rotate(${angle}deg)` }}>
                <span className="atom-electron" style={{ width: cfg.electron, height: cfg.electron }} />
              </div>
            );
          })}
        </div>
      ))}

      <div className="atom-nucleus" style={{ width: `${cfg.nucleus}%`, height: `${cfg.nucleus}%` }}>
        {nucleons.map((p, i) => (
          <span
            key={i}
            className={`atom-nucleon ${p.proton ? 'proton' : 'neutron'}`}
            style={{ left: `${p.x}%`, top: `${p.y}%`, width: cfg.nucleonSize, height: cfg.nucleonSize }}
          />
        ))}
      </div>

      {plate && (
        <div className="atom-plate">
          <span className="anum">115</span>
          <span className="asym">Mc</span>
          <span className="aname">Moscovium</span>
          <span className="amass">[290]</span>
          <span className="acite">Dubna · JINR · 2003</span>
        </div>
      )}

      {legend && (
        <div className="atom-legend">
          <span><i className="atom-key proton" />115 p<sup>+</sup></span>
          <span><i className="atom-key neutron" />175 n<sup>0</sup></span>
          <span><i className="atom-key electron" />115 e<sup>−</sup></span>
        </div>
      )}
    </div>
  );
}
