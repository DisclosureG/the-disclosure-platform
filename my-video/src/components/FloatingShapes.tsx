import React from "react";
import { useCurrentFrame, AbsoluteFill } from "remotion";
import { c } from "../theme";
import { floatY } from "../anim";
import { Sparkle } from "./Sparkle";

// A calm, ambient field of soft pastel shapes drifting near the edges of the
// frame. Deterministic, low-contrast, and kept out of the central text zone so
// it reads as gentle joy, never clutter.

type Shape = {
  id: string;
  kind: "ring" | "disc" | "pill" | "plus" | "sparkle" | "tri";
  x: number; // vw %
  y: number; // vh %
  size: number;
  color: string;
  amp: number;
  period: number;
  phase: number;
  rot: number;
  opacity: number;
};

const SHAPES: Shape[] = [
  { id: "a", kind: "disc", x: 8, y: 18, size: 120, color: c.coralSoft, amp: 16, period: 220, phase: 0.2, rot: 0, opacity: 0.85 },
  { id: "b", kind: "ring", x: 90, y: 14, size: 90, color: c.sky, amp: 22, period: 260, phase: 1.1, rot: 0, opacity: 0.5 },
  { id: "c", kind: "sparkle", x: 82, y: 26, size: 30, color: c.butter, amp: 12, period: 150, phase: 2.0, rot: 0, opacity: 0.9 },
  { id: "d", kind: "pill", x: 6, y: 78, size: 90, color: c.skySoft, amp: 18, period: 240, phase: 0.7, rot: -18, opacity: 0.9 },
  { id: "e", kind: "disc", x: 93, y: 82, size: 80, color: c.sageSoft, amp: 20, period: 200, phase: 1.6, rot: 0, opacity: 0.95 },
  { id: "f", kind: "plus", x: 14, y: 44, size: 26, color: c.sky, amp: 14, period: 180, phase: 0.4, rot: 0, opacity: 0.45 },
  { id: "g", kind: "ring", x: 12, y: 90, size: 54, color: c.coral, amp: 16, period: 230, phase: 2.4, rot: 0, opacity: 0.4 },
  { id: "h", kind: "sparkle", x: 6, y: 8, size: 24, color: c.coral, amp: 10, period: 140, phase: 3.1, rot: 0, opacity: 0.8 },
  { id: "i", kind: "tri", x: 95, y: 50, size: 40, color: c.lilacSoft, amp: 18, period: 250, phase: 0.9, rot: 12, opacity: 0.95 },
  { id: "j", kind: "disc", x: 88, y: 64, size: 30, color: c.butter, amp: 12, period: 170, phase: 1.9, rot: 0, opacity: 0.5 },
  { id: "k", kind: "pill", x: 96, y: 34, size: 64, color: c.coralSoft, amp: 16, period: 210, phase: 2.7, rot: 24, opacity: 0.85 },
  { id: "l", kind: "plus", x: 90, y: 92, size: 22, color: c.sage, amp: 12, period: 160, phase: 0.1, rot: 0, opacity: 0.5 },
  { id: "m", kind: "sparkle", x: 16, y: 64, size: 20, color: c.lilac, amp: 10, period: 150, phase: 2.2, rot: 0, opacity: 0.7 },
  { id: "n", kind: "disc", x: 4, y: 36, size: 44, color: c.lilacSoft, amp: 14, period: 230, phase: 1.3, rot: 0, opacity: 0.9 },
];

const ShapeView: React.FC<{ s: Shape }> = ({ s }) => {
  const frame = useCurrentFrame();
  const dy = floatY(frame, s.amp, s.period, s.phase);
  const dx = floatY(frame, s.amp * 0.6, s.period * 1.3, s.phase + 1.5);
  const spin = s.rot + floatY(frame, 6, s.period * 1.7, s.phase) * 0.4;
  const common: React.CSSProperties = {
    position: "absolute",
    left: `${s.x}%`,
    top: `${s.y}%`,
    transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) rotate(${spin}deg)`,
    opacity: s.opacity,
  };

  switch (s.kind) {
    case "disc":
      return <div style={{ ...common, width: s.size, height: s.size, borderRadius: "50%", background: s.color }} />;
    case "ring":
      return (
        <div
          style={{
            ...common,
            width: s.size,
            height: s.size,
            borderRadius: "50%",
            border: `${Math.max(4, s.size * 0.08)}px solid ${s.color}`,
          }}
        />
      );
    case "pill":
      return <div style={{ ...common, width: s.size, height: s.size * 0.46, borderRadius: 999, background: s.color }} />;
    case "plus":
      return (
        <div style={common}>
          <div style={{ position: "absolute", left: -s.size / 2, top: -s.size * 0.16, width: s.size, height: s.size * 0.32, borderRadius: 999, background: s.color }} />
          <div style={{ position: "absolute", left: -s.size * 0.16, top: -s.size / 2, width: s.size * 0.32, height: s.size, borderRadius: 999, background: s.color }} />
        </div>
      );
    case "tri":
      return (
        <div
          style={{
            ...common,
            width: 0,
            height: 0,
            borderLeft: `${s.size / 2}px solid transparent`,
            borderRight: `${s.size / 2}px solid transparent`,
            borderBottom: `${s.size * 0.86}px solid ${s.color}`,
            borderRadius: 8,
          }}
        />
      );
    case "sparkle":
      return (
        <div style={common}>
          <Sparkle size={s.size} color={s.color} style={{ transform: "translate(-50%, -50%)", position: "absolute" }} />
        </div>
      );
  }
};

export const FloatingShapes: React.FC = () => (
  <AbsoluteFill style={{ pointerEvents: "none" }}>
    {SHAPES.map((s) => (
      <ShapeView key={s.id} s={s} />
    ))}
  </AbsoluteFill>
);
