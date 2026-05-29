import React from "react";
import { useVideoConfig } from "remotion";
import { c, radius, shadow } from "../theme";
import { fonts } from "../fonts";
import { SceneLayout } from "../components/SceneLayout";
import { SceneHeader } from "../components/SceneHeader";
import { Appear, RiseIn } from "../components/ui";
import { IconByName, type IconName, Heart } from "../components/Icons";

export type RefusalsShotProps = {
  kicker: string;
  headline: string;
  banner: string;
  items: Array<{ icon: IconName; label: string }>;
};

const RefusalCard: React.FC<{ item: RefusalsShotProps["items"][number] }> = ({ item }) => {
  const Ico = IconByName[item.icon];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 20,
        background: c.card,
        borderRadius: radius.inner,
        boxShadow: shadow.soft,
        padding: "24px 28px",
      }}
    >
      {/* icon with a friendly coral "no" slash */}
      <div style={{ position: "relative", width: 54, height: 54, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Ico size={36} color={c.inkGhost} strokeWidth={1.9} />
        <div style={{ position: "absolute", width: 62, height: 5, borderRadius: 999, background: c.coral, transform: "rotate(-45deg)" }} />
      </div>
      <span style={{ fontFamily: fonts.display, fontWeight: 600, fontSize: 28, color: c.ink }}>{item.label}</span>
    </div>
  );
};

export const RefusalsShot: React.FC<RefusalsShotProps> = ({ kicker, headline, banner, items }) => {
  const { durationInFrames: dur } = useVideoConfig();
  return (
    <SceneLayout align="top" padY={92}>
      <SceneHeader kicker={kicker} headline={headline} size={60} marginBottom={50} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 24, width: "100%", maxWidth: 1440 }}>
        {items.map((it, i) => (
          <Appear key={i} delay={10 + i * 6} origin="center">
            <RefusalCard item={it} />
          </Appear>
        ))}
      </div>
      <RiseIn delay={Math.round(dur * 0.7)} style={{ marginTop: 48 }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 16,
            padding: "20px 38px",
            borderRadius: radius.chip,
            background: c.coralSoft,
            boxShadow: shadow.chip,
          }}
        >
          <Heart size={32} color={c.coralDeep} strokeWidth={2} />
          <span style={{ fontFamily: fonts.display, fontWeight: 600, fontSize: 32, color: c.coralDeep }}>{banner}</span>
        </div>
      </RiseIn>
    </SceneLayout>
  );
};
