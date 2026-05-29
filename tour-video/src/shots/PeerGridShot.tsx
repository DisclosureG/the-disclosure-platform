import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { c, shadow } from "../theme";
import { fonts } from "../fonts";
import { SceneLayout } from "../components/SceneLayout";
import { SceneHeader } from "../components/SceneHeader";
import { RiseIn } from "../components/ui";
import { Check, Plus, ArrowRight } from "../components/Icons";
import { Confetti } from "../components/Confetti";
import { pop } from "../anim";

type Person = { initials: string; color: string; soft: string; leaving?: boolean };

export type PeerGridShotProps = {
  kicker: string;
  headline: string;
  caption: string;
  threshold: number;
  nominee: { initials: string; color: string; soft: string };
  members: Person[];
};

const MemberAvatar: React.FC<{ p: Person; appear: number; leaveAt: number; size?: number }> = ({ p, appear, leaveAt, size = 104 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const intro = pop(frame, fps, appear);
  let opacity = intro.opacity;
  let scale = intro.scale;
  if (p.leaving) {
    const leave = interpolate(frame, [leaveAt, leaveAt + 24], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    opacity *= 1 - leave * 0.82;
    scale *= 1 - leave * 0.18;
  }
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: p.leaving ? c.cardAlt : p.soft,
        border: p.leaving ? `2px dashed ${c.line}` : "none",
        color: p.color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: fonts.display,
        fontWeight: 700,
        fontSize: size * 0.3,
        transform: `scale(${scale})`,
        opacity,
        boxShadow: p.leaving ? "none" : shadow.chip,
      }}
    >
      {p.initials}
    </div>
  );
};

export const PeerGridShot: React.FC<PeerGridShotProps> = ({ kicker, headline, caption, threshold, nominee, members }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames: dur } = useVideoConfig();

  const ghostAt = Math.round(dur * 0.12);
  const eStart = Math.round(dur * 0.3);
  const eEnd = Math.round(dur * 0.52);
  const verifyAt = Math.round(dur * 0.54);
  const leaveAt = Math.round(dur * 0.74);

  const ghost = pop(frame, fps, ghostAt);
  const endorseCount = Math.min(threshold, Math.floor(interpolate(frame, [eStart, eEnd], [0, threshold + 0.99], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })));
  const verified = frame >= verifyAt;
  const checkPop = pop(frame, fps, verifyAt + 2);

  return (
    <SceneLayout align="top" padY={92}>
      <SceneHeader kicker={kicker} headline={headline} size={58} marginBottom={46} kickerColor={c.lilac} kickerSoft={c.lilacSoft} />

      {/* featured nominee */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, marginBottom: 18 }}>
        <div style={{ position: "relative", transform: `scale(${ghost.scale})`, opacity: ghost.opacity }}>
          <div
            style={{
              width: 132,
              height: 132,
              borderRadius: "50%",
              background: verified ? nominee.soft : c.cardAlt,
              border: verified ? "none" : `3px dashed ${c.inkGhost}`,
              boxShadow: verified ? shadow.card : "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: verified ? nominee.color : c.inkDim,
              fontFamily: fonts.display,
              fontWeight: 700,
              fontSize: 44,
            }}
          >
            {verified ? nominee.initials : <Plus size={48} color={c.inkDim} strokeWidth={2} />}
          </div>
          {/* verified check badge */}
          {verified ? (
            <div style={{ position: "absolute", right: -6, bottom: -6, transform: `scale(${checkPop.scale})`, opacity: checkPop.opacity, width: 50, height: 50, borderRadius: "50%", background: c.good, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: shadow.chip, border: `4px solid ${c.paper}` }}>
              <Check size={26} color={c.white} strokeWidth={3} />
            </div>
          ) : null}
        </div>
        {/* status pill: counter -> verified */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 22px",
            borderRadius: 999,
            background: verified ? c.goodSoft : c.cardAlt,
            color: verified ? c.good : c.inkSoft,
            fontFamily: fonts.body,
            fontWeight: 700,
            fontSize: 20,
            letterSpacing: 0.6,
            boxShadow: shadow.chip,
          }}
        >
          {verified ? (
            <>
              <Check size={20} color={c.good} strokeWidth={2.8} /> Verified peer
            </>
          ) : (
            <>Endorsed&nbsp;&nbsp;{endorseCount}/{threshold}</>
          )}
        </div>
      </div>

      <RiseIn delay={Math.round(dur * 0.62)} distance={16} style={{ marginBottom: 22 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, color: c.inkDim, fontFamily: fonts.body, fontWeight: 600, fontSize: 20, letterSpacing: 1, textTransform: "uppercase" }}>
          Welcomed by the group <ArrowRight size={22} color={c.inkDim} strokeWidth={2} />
        </div>
      </RiseIn>

      {/* the community */}
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 26, maxWidth: 1120 }}>
        {members.map((p, i) => (
          <MemberAvatar key={i} p={p} appear={6 + i * 4} leaveAt={leaveAt} />
        ))}
      </div>

      <RiseIn delay={Math.round(dur * 0.84)} style={{ marginTop: 40 }}>
        <div style={{ fontFamily: fonts.body, fontWeight: 500, fontSize: 24, color: c.inkDim, textAlign: "center" }}>{caption}</div>
      </RiseIn>

      <Confetti count={32} startFrame={verifyAt + 2} originX={0.5} originY={0.34} power={0.7} />
    </SceneLayout>
  );
};
