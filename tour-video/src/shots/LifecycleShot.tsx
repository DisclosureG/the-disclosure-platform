import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { c, radius, shadow } from "../theme";
import { fonts } from "../fonts";
import { SceneLayout } from "../components/SceneLayout";
import { SceneHeader } from "../components/SceneHeader";
import { RiseIn } from "../components/ui";
import { IconByName, type IconName, Refresh, Check } from "../components/Icons";
import { Confetti } from "../components/Confetti";
import { pop } from "../anim";

export type LifecycleShotProps = {
  kicker: string;
  headline: string;
  stations: Array<{ label: string; icon: IconName; color: string; soft: string }>;
  branchTryAgain: string;
  branchRevisit: string;
};

const W = 1380;
const CARD_W = 372;
const ROW_H = 168;
const centers = [CARD_W / 2, W / 2, W - CARD_W / 2];

const Station: React.FC<{
  s: LifecycleShotProps["stations"][number];
  appear: number;
  active: number;
}> = ({ s, appear, active }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const intro = pop(frame, fps, appear);
  const fill = interpolate(frame, [active, active + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const pulse = interpolate(frame, [active, active + 8, active + 24], [0, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const lit = fill > 0.4;
  const Ico = IconByName[s.icon];
  return (
    <div
      style={{
        width: CARD_W,
        height: ROW_H,
        transform: `scale(${intro.scale * (1 + 0.045 * pulse)})`,
        opacity: intro.opacity,
        background: c.card,
        borderRadius: radius.card,
        boxShadow: lit ? `0 0 0 4px ${s.soft}, ${shadow.card}` : shadow.soft,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        zIndex: 2,
      }}
    >
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 20,
          background: lit ? s.soft : "#EFEADF",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ico size={34} color={lit ? s.color : c.inkDim} strokeWidth={1.9} />
      </div>
      <div style={{ fontFamily: fonts.display, fontWeight: 600, fontSize: 27, color: lit ? c.ink : c.inkDim }}>
        {s.label}
      </div>
    </div>
  );
};

const BranchCard: React.FC<{ icon: React.ReactNode; text: string; tint: string }> = ({ icon, text, tint }) => (
  <div
    style={{
      flex: 1,
      display: "flex",
      alignItems: "center",
      gap: 18,
      background: c.cardAlt,
      borderRadius: radius.inner,
      boxShadow: shadow.soft,
      padding: "22px 26px",
    }}
  >
    <div style={{ width: 52, height: 52, borderRadius: 16, background: tint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      {icon}
    </div>
    <div style={{ fontFamily: fonts.body, fontWeight: 500, fontSize: 22, color: c.inkSoft, lineHeight: 1.4 }}>{text}</div>
  </div>
);

export const LifecycleShot: React.FC<LifecycleShotProps> = ({ kicker, headline, stations, branchTryAgain, branchRevisit }) => {
  const frame = useCurrentFrame();
  const { durationInFrames: dur } = useVideoConfig();

  const appears = [0.04, 0.09, 0.14].map((p) => Math.round(dur * p));
  const actives = [0.12, 0.27, 0.42].map((p) => Math.round(dur * p));
  const move1 = [0.16, 0.27].map((p) => Math.round(dur * p));
  const move2 = [0.31, 0.42].map((p) => Math.round(dur * p));

  const tokenX = interpolate(
    frame,
    [move1[0], move1[1], move2[0], move2[1]],
    [centers[0], centers[1], centers[1], centers[2]],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const tokenVisible = interpolate(frame, [move1[0] - 6, move1[0], actives[2] + 16, actives[2] + 30], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const progressX = tokenX;

  return (
    <SceneLayout align="top" padY={94}>
      <SceneHeader kicker={kicker} headline={headline} size={58} marginBottom={64} />

      <div style={{ position: "relative", width: W, height: ROW_H, marginBottom: 46 }}>
        {/* base + progress connector */}
        <div style={{ position: "absolute", top: ROW_H / 2 - 3, left: centers[0], width: centers[2] - centers[0], height: 6, borderRadius: 999, background: c.lineSoft, zIndex: 1 }} />
        <div style={{ position: "absolute", top: ROW_H / 2 - 3, left: centers[0], width: Math.max(0, progressX - centers[0]), height: 6, borderRadius: 999, background: c.coral, zIndex: 1, opacity: tokenVisible > 0 ? 1 : 0 }} />
        {/* traveling token */}
        <div
          style={{
            position: "absolute",
            top: ROW_H / 2 - 13,
            left: tokenX - 13,
            width: 26,
            height: 26,
            borderRadius: "50%",
            background: c.coral,
            boxShadow: `0 0 0 6px ${c.coralSoft}`,
            opacity: tokenVisible,
            zIndex: 3,
          }}
        />
        {/* stations */}
        <div style={{ position: "absolute", inset: 0, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          {stations.map((s, i) => (
            <Station key={i} s={s} appear={appears[i]} active={actives[i]} />
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 26, width: "100%", maxWidth: W }}>
        <RiseIn delay={Math.round(dur * 0.56)} style={{ flex: 1, display: "flex" }}>
          <BranchCard icon={<Refresh size={28} color={c.sky} strokeWidth={2} />} text={branchTryAgain} tint={c.skySoft} />
        </RiseIn>
        <RiseIn delay={Math.round(dur * 0.73)} style={{ flex: 1, display: "flex" }}>
          <BranchCard icon={<Check size={28} color={c.good} strokeWidth={2.4} />} text={branchRevisit} tint={c.goodSoft} />
        </RiseIn>
      </div>

      <Confetti count={30} startFrame={actives[2] + 2} originX={(centers[2] / W) * 0.78 + 0.11} originY={0.45} power={0.6} />
    </SceneLayout>
  );
};
