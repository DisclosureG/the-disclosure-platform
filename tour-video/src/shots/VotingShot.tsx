import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { c, radius, shadow } from "../theme";
import { fonts } from "../fonts";
import { SceneLayout } from "../components/SceneLayout";
import { SceneHeader } from "../components/SceneHeader";
import { Appear, RiseIn } from "../components/ui";
import { Check, Pen, Note, Link } from "../components/Icons";

export type VotingShotProps = {
  kicker: string;
  headline: string;
  peerHandle: string;
  peerAddr: string;
  peerInitials: string;
  tierLabel: string;
  verdict: string;
  note: string;
  footer: string;
};

export const VotingShot: React.FC<VotingShotProps> = ({
  kicker,
  headline,
  peerHandle,
  peerAddr,
  peerInitials,
  tierLabel,
  verdict,
  note,
  footer,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames: dur } = useVideoConfig();

  const stampAt = Math.round(dur * 0.4);
  const stamp = interpolate(frame, [stampAt, stampAt + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const stampScale = interpolate(frame, [stampAt, stampAt + 10, stampAt + 16], [1.8, 0.94, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const stampRot = interpolate(frame, [stampAt, stampAt + 16], [-14, -7], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const sigStart = Math.round(dur * 0.44);
  const sigDraw = interpolate(frame, [sigStart, sigStart + 26], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const SIG_LEN = 720;

  return (
    <SceneLayout align="top" padY={96}>
      <SceneHeader kicker={kicker} headline={headline} size={58} marginBottom={52} kickerColor={c.coralDeep} kickerSoft={c.coralSoft} />

      <Appear delay={Math.round(dur * 0.04)} origin="center top">
        <div style={{ width: 1000, background: c.card, borderRadius: radius.card, boxShadow: shadow.lift, padding: 46, position: "relative", overflow: "hidden" }}>
          {/* peer header */}
          <RiseIn delay={Math.round(dur * 0.1)} distance={20}>
            <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
              <div style={{ width: 70, height: 70, borderRadius: "50%", background: c.skySoft, color: c.sky, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: fonts.display, fontWeight: 700, fontSize: 26 }}>
                {peerInitials}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5, flex: 1 }}>
                <span style={{ fontFamily: fonts.display, fontWeight: 600, fontSize: 30, color: c.ink }}>{peerHandle}</span>
                <span style={{ fontFamily: fonts.mono, fontWeight: 400, fontSize: 20, color: c.inkDim }}>{peerAddr}</span>
              </div>
              <span style={{ padding: "9px 18px", borderRadius: 999, background: c.butterSoft, color: "#B8801F", fontFamily: fonts.body, fontWeight: 700, fontSize: 17, letterSpacing: 0.5 }}>
                {tierLabel}
              </span>
            </div>
          </RiseIn>

          <div style={{ height: 2, background: c.lineSoft, margin: "30px 0" }} />

          {/* verdict + signed stamp */}
          <div style={{ display: "flex", alignItems: "center", gap: 22, position: "relative" }}>
            <Appear delay={Math.round(dur * 0.28)}>
              <div style={{ width: 64, height: 64, borderRadius: "50%", background: c.goodSoft, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Check size={36} color={c.good} strokeWidth={2.6} />
              </div>
            </Appear>
            <RiseIn delay={Math.round(dur * 0.3)} distance={16} style={{ flex: 1 }}>
              <span style={{ fontFamily: fonts.display, fontWeight: 600, fontSize: 34, color: c.ink }}>{verdict}</span>
            </RiseIn>
            <div
              style={{
                opacity: stamp,
                transform: `scale(${stampScale}) rotate(${stampRot}deg)`,
                display: "inline-flex",
                alignItems: "center",
                gap: 10,
                padding: "12px 22px",
                borderRadius: 16,
                border: `3px solid ${c.coral}`,
                color: c.coralDeep,
                fontFamily: fonts.display,
                fontWeight: 700,
                fontSize: 26,
                letterSpacing: 2,
              }}
            >
              <Pen size={26} color={c.coralDeep} strokeWidth={2.2} /> SIGNED
            </div>
          </div>

          {/* drawing signature */}
          <svg width={520} height={90} viewBox="0 0 520 90" style={{ marginTop: 8, marginLeft: 86 }}>
            <path
              d="M8 60 C 40 6, 70 4, 78 46 C 84 78, 60 84, 66 54 C 74 18, 120 14, 150 50 C 176 80, 210 26, 250 48 C 286 68, 300 20, 348 40 C 392 58, 430 30, 512 36"
              fill="none"
              stroke={c.coral}
              strokeWidth={4}
              strokeLinecap="round"
              strokeDasharray={SIG_LEN}
              strokeDashoffset={SIG_LEN * (1 - sigDraw)}
            />
          </svg>

          {/* deliberation note */}
          <RiseIn delay={Math.round(dur * 0.66)} distance={24} style={{ marginTop: 14 }}>
            <div style={{ display: "flex", gap: 18, background: c.cardAlt, borderRadius: radius.inner, padding: "24px 28px" }}>
              <Note size={30} color={c.coral} strokeWidth={1.9} style={{ flexShrink: 0, marginTop: 2 }} />
              <span style={{ fontFamily: fonts.body, fontWeight: 500, fontSize: 25, color: c.inkSoft, lineHeight: 1.45, fontStyle: "italic" }}>
                “{note}”
              </span>
            </div>
          </RiseIn>

          {/* footer */}
          <RiseIn delay={Math.round(dur * 0.82)} distance={14} style={{ marginTop: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 11, justifyContent: "center" }}>
              <Link size={22} color={c.inkDim} strokeWidth={2} />
              <span style={{ fontFamily: fonts.mono, fontWeight: 400, fontSize: 19, color: c.inkDim, letterSpacing: 0.3 }}>{footer}</span>
            </div>
          </RiseIn>
        </div>
      </Appear>
    </SceneLayout>
  );
};
