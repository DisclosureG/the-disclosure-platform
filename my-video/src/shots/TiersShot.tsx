import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { c, radius, shadow } from "../theme";
import { fonts } from "../fonts";
import { SceneLayout } from "../components/SceneLayout";
import { SceneHeader } from "../components/SceneHeader";
import { RiseIn } from "../components/ui";
import { pop } from "../anim";

export type TiersShotProps = {
  kicker: string;
  headline: string;
  callout: string;
  items: Array<{
    roman: string;
    title: string;
    sub: string;
    color: string;
    soft: string;
    strength: number; // 1..3 filled pips
    at: number; // seconds into scene when this tier is named
  }>;
};

const TierCard: React.FC<{ it: TiersShotProps["items"][number] }> = ({ it }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const delay = Math.round(it.at * fps);
  const { scale, opacity } = pop(frame, fps, delay);
  return (
    <div
      style={{
        flex: 1,
        transform: `scale(${scale})`,
        opacity,
        transformOrigin: "center bottom",
        background: c.card,
        borderRadius: radius.card,
        boxShadow: shadow.card,
        border: `2px solid ${it.soft}`,
        padding: "40px 34px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        gap: 18,
      }}
    >
      <div
        style={{
          width: 92,
          height: 92,
          borderRadius: 26,
          background: it.soft,
          color: it.color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: fonts.display,
          fontWeight: 700,
          fontSize: 40,
        }}
      >
        {it.roman}
      </div>
      <div style={{ fontFamily: fonts.display, fontWeight: 600, fontSize: 30, color: c.ink, lineHeight: 1.12 }}>
        {it.title}
      </div>
      <div style={{ fontFamily: fonts.body, fontWeight: 400, fontSize: 21, color: c.inkSoft, lineHeight: 1.42 }}>
        {it.sub}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        {[0, 1, 2].map((p) => (
          <span
            key={p}
            style={{
              width: 26,
              height: 9,
              borderRadius: 999,
              background: p < it.strength ? it.color : it.soft,
            }}
          />
        ))}
      </div>
    </div>
  );
};

export const TiersShot: React.FC<TiersShotProps> = ({ kicker, headline, callout, items }) => (
  <SceneLayout align="top" padY={92}>
    <SceneHeader kicker={kicker} headline={headline} marginBottom={52} />
    <div style={{ display: "flex", gap: 30, width: "100%", maxWidth: 1440, alignItems: "stretch" }}>
      {items.map((it, i) => (
        <TierCard key={i} it={it} />
      ))}
    </div>
    <RiseIn delay={Math.round(items[items.length - 1].at * 30) + 22} style={{ marginTop: 44 }}>
      <div
        style={{
          fontFamily: fonts.body,
          fontWeight: 500,
          fontSize: 23,
          color: c.inkDim,
          textAlign: "center",
          maxWidth: 900,
        }}
      >
        {callout}
      </div>
    </RiseIn>
  </SceneLayout>
);
