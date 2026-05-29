import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { c, radius, shadow } from "../theme";
import { fonts } from "../fonts";
import { SceneLayout } from "../components/SceneLayout";
import { SceneHeader } from "../components/SceneHeader";
import { IconByName, type IconName, ArrowRight, Check } from "../components/Icons";
import { pop } from "../anim";

export type WallsShotProps = {
  kicker: string;
  headline: string;
  items: Array<{ icon: IconName; problem: string; solutionIcon: IconName; solution: string }>;
};

const Wall: React.FC<{ item: WallsShotProps["items"][number]; problemAt: number; solutionAt: number }> = ({ item, problemAt, solutionAt }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pIntro = pop(frame, fps, problemAt);
  const solIn = interpolate(frame, [solutionAt, solutionAt + 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const dim = interpolate(frame, [solutionAt, solutionAt + 16], [1, 0.5], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const PIco = IconByName[item.icon];
  const SIco = IconByName[item.solutionIcon];
  return (
    <div
      style={{
        transform: `scale(${pIntro.scale})`,
        opacity: pIntro.opacity,
        display: "flex",
        alignItems: "center",
        gap: 22,
        background: c.card,
        borderRadius: radius.card,
        boxShadow: shadow.card,
        padding: "22px 30px",
        width: "100%",
      }}
    >
      {/* problem */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 18, opacity: dim }}>
        <div style={{ width: 60, height: 60, borderRadius: 18, background: c.blushSoft, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <PIco size={32} color={c.retire} strokeWidth={1.9} />
        </div>
        <span style={{ fontFamily: fonts.display, fontWeight: 600, fontSize: 27, color: c.ink }}>{item.problem}</span>
      </div>
      {/* arrow */}
      <div style={{ opacity: solIn, flexShrink: 0 }}>
        <ArrowRight size={34} color={c.inkDim} strokeWidth={2} />
      </div>
      {/* solution */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 16, opacity: solIn, transform: `translateX(${(1 - solIn) * 36}px)` }}>
        <div style={{ width: 60, height: 60, borderRadius: 18, background: c.goodSoft, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <SIco size={32} color={c.good} strokeWidth={1.9} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontFamily: fonts.body, fontWeight: 700, fontSize: 14, letterSpacing: 1.4, textTransform: "uppercase", color: c.good }}>
            <Check size={15} color={c.good} strokeWidth={3} /> Designed out
          </span>
          <span style={{ fontFamily: fonts.display, fontWeight: 600, fontSize: 26, color: c.ink }}>{item.solution}</span>
        </div>
      </div>
    </div>
  );
};

export const WallsShot: React.FC<WallsShotProps> = ({ kicker, headline, items }) => {
  const { durationInFrames: dur } = useVideoConfig();
  return (
    <SceneLayout align="top" padY={94}>
      <SceneHeader kicker={kicker} headline={headline} size={58} marginBottom={48} />
      <div style={{ display: "flex", flexDirection: "column", gap: 22, width: "100%", maxWidth: 1380 }}>
        {items.map((it, i) => (
          <Wall key={i} item={it} problemAt={Math.round(dur * (0.08 + i * 0.06))} solutionAt={Math.round(dur * (0.52 + i * 0.07))} />
        ))}
      </div>
    </SceneLayout>
  );
};
