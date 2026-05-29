import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { c, radius, shadow } from "../theme";
import { fonts } from "../fonts";
import { SceneLayout } from "../components/SceneLayout";
import { RiseIn } from "../components/ui";
import { DMark } from "../components/DMark";
import { Sparkle } from "../components/Sparkle";
import { Confetti } from "../components/Confetti";
import { Link } from "../components/Icons";
import { enter, floatY, SPRING } from "../anim";

// The closing card — a cute, warm brand sign-off. The coral "D" sigil pops in
// with a little tilt-settle and a soft "ta-da" ring, sparkles twinkle and
// confetti bursts around it, then the wordmark, tagline, and URL rise. It holds
// gently (sigil keeps bobbing, sparkles keep twinkling) so the last frame still
// feels alive.
export type OutroShotProps = {
  brand: string;
  tagline: string;
  url: string;
};

// Twinkles scattered around the sigil — offsets from its centre.
const TWINKLES = [
  { x: -168, y: -74, size: 28, color: c.butter, phase: 0.0, delay: 14 },
  { x: 176, y: -46, size: 22, color: c.sky, phase: 1.3, delay: 18 },
  { x: -186, y: 86, size: 20, color: c.lilac, phase: 2.5, delay: 22 },
  { x: 162, y: 98, size: 30, color: c.sage, phase: 0.7, delay: 16 },
  { x: 6, y: -156, size: 18, color: c.blush, phase: 1.9, delay: 24 },
  { x: 214, y: 34, size: 16, color: c.coral, phase: 3.1, delay: 20 },
  { x: -212, y: 6, size: 16, color: c.sky, phase: 2.1, delay: 26 },
];

const Ring: React.FC<{ start: number }> = ({ start }) => {
  const frame = useCurrentFrame();
  const t = frame - start;
  if (t < 0) return null;
  const scale = interpolate(t, [0, 42], [0.66, 2.5], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const opacity = interpolate(t, [0, 7, 42], [0, 0.55, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  if (opacity <= 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        width: 168,
        height: 168,
        marginLeft: -84,
        marginTop: -84,
        borderRadius: "50%",
        border: `4px solid ${c.coral}`,
        opacity,
        transform: `scale(${scale})`,
      }}
    />
  );
};

export const OutroShot: React.FC<OutroShotProps> = ({ brand, tagline, url }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames: dur } = useVideoConfig();

  // Hero sigil: bouncy pop + a tilt that settles, then a slow idle bob.
  const sig = enter(frame, fps, 4, SPRING.bounce);
  const sigScale = interpolate(sig, [0, 1], [0.3, 1]);
  const sigRot = interpolate(sig, [0, 1], [-13, 0]);
  const sigOpacity = interpolate(frame - 4, [0, 7], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const bob = floatY(frame, 7, 150);

  return (
    <SceneLayout>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        {/* hero stage: rings + sigil + twinkles */}
        <div style={{ position: "relative", width: 460, height: 320, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Ring start={7} />
          <Ring start={18} />

          {TWINKLES.map((tw, i) => {
            const osc = (Math.sin((frame / 64) * Math.PI * 2 + tw.phase) + 1) / 2; // 0..1
            const gate = interpolate(frame - tw.delay, [0, 9], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            const tScale = (0.55 + 0.45 * osc) * gate;
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  transform: `translate(-50%, -50%) translate(${tw.x}px, ${tw.y + bob * 0.4}px) scale(${tScale})`,
                  opacity: (0.4 + 0.6 * osc) * gate,
                }}
              >
                <Sparkle size={tw.size} color={tw.color} />
              </div>
            );
          })}

          <div
            style={{
              transform: `translateY(${bob}px) scale(${sigScale}) rotate(${sigRot}deg)`,
              opacity: sigOpacity,
            }}
          >
            <div
              style={{
                width: 168,
                height: 168,
                borderRadius: 48,
                background: c.coral,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: shadow.lift,
              }}
            >
              <DMark size={128} color={c.white} />
            </div>
          </div>
        </div>

        {/* wordmark */}
        <RiseIn delay={18} distance={26} style={{ marginTop: 14 }}>
          <div
            style={{
              fontFamily: fonts.display,
              fontWeight: 600,
              fontSize: 68,
              color: c.ink,
              letterSpacing: -1,
              lineHeight: 1,
            }}
          >
            {brand}
          </div>
        </RiseIn>

        {/* tagline */}
        <RiseIn delay={26} distance={20} style={{ marginTop: 22 }}>
          <div
            style={{
              fontFamily: fonts.body,
              fontWeight: 500,
              fontSize: 30,
              color: c.inkSoft,
              letterSpacing: 0.3,
            }}
          >
            {tagline}
          </div>
        </RiseIn>

        {/* url */}
        <RiseIn delay={Math.round(dur * 0.34)} distance={18} style={{ marginTop: 44 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 15,
              padding: "18px 38px",
              borderRadius: radius.chip,
              background: c.coral,
              boxShadow: shadow.lift,
            }}
          >
            <Link size={26} color={c.white} strokeWidth={2.4} />
            <span style={{ fontFamily: fonts.mono, fontWeight: 500, fontSize: 32, color: c.white, letterSpacing: 0.5 }}>{url}</span>
          </div>
        </RiseIn>
      </div>

      <Confetti count={76} startFrame={6} originX={0.5} originY={0.4} power={1.2} />
    </SceneLayout>
  );
};
