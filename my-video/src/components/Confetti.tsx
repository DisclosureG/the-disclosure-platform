import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate, random } from "remotion";
import { c } from "../theme";

// A gentle confetti burst for joyful beats (CTA, a ratified topic). Particles
// arc out from an origin, drift down softly, twirl, and fade. Deterministic.
const PALETTE = [c.coral, c.sky, c.sage, c.butter, c.lilac, c.blush];

export const Confetti: React.FC<{
  count?: number;
  startFrame?: number;
  originX?: number; // 0..1
  originY?: number; // 0..1
  power?: number;
}> = ({ count = 46, startFrame = 0, originX = 0.5, originY = 0.46, power = 1 }) => {
  const frame = useCurrentFrame();
  const t = frame - startFrame;
  if (t < 0) return null;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {new Array(count).fill(0).map((_, i) => {
        const seed = `c${i}`;
        const angle = (-90 + (random(seed + "a") - 0.5) * 150) * (Math.PI / 180);
        const speed = (10 + random(seed + "s") * 16) * power;
        const vx = Math.cos(angle) * speed;
        const vy = Math.sin(angle) * speed;
        const g = 0.6;
        const x = originX * 1920 + vx * t;
        const y = originY * 1080 + vy * t + 0.5 * g * t * t;
        const rot = random(seed + "r") * 360 + t * (random(seed + "rs") * 16 - 8);
        const size = 10 + random(seed + "z") * 14;
        const color = PALETTE[Math.floor(random(seed + "c") * PALETTE.length)];
        const round = random(seed + "shape") > 0.5;
        const opacity = interpolate(t, [0, 6, 48, 70], [0, 1, 1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        if (opacity <= 0) return null;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: size,
              height: round ? size : size * 0.5,
              borderRadius: round ? "50%" : 3,
              background: color,
              opacity,
              transform: `rotate(${rot}deg)`,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
