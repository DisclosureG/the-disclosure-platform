import React from "react";
import { useVideoConfig } from "remotion";
import { c, radius, shadow } from "../theme";
import { fonts } from "../fonts";
import { SceneLayout } from "../components/SceneLayout";
import { Appear, RiseIn } from "../components/ui";
import { Headline } from "../components/Headline";
import { Wordmark } from "../components/Wordmark";
import { IconByName, type IconName, Link } from "../components/Icons";

export type CTAShotProps = {
  headline: string;
  actions: Array<{ icon: IconName; label: string; color: string; soft: string }>;
  url: string;
};

export const CTAShot: React.FC<CTAShotProps> = ({ headline, actions, url }) => {
  const { durationInFrames: dur } = useVideoConfig();
  return (
    <SceneLayout>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <Appear delay={2} style={{ marginBottom: 44 }}>
          <Wordmark tag={false} scale={1.1} />
        </Appear>

        <Headline text={headline} size={86} delay={8} maxWidth={1400} />

        <div style={{ display: "flex", gap: 20, marginTop: 50, flexWrap: "wrap", justifyContent: "center" }}>
          {actions.map((a, i) => {
            const Ico = IconByName[a.icon];
            return (
              <Appear key={i} delay={26 + i * 6}>
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 13,
                    padding: "17px 28px 17px 22px",
                    borderRadius: radius.chip,
                    background: c.card,
                    boxShadow: shadow.chip,
                  }}
                >
                  <div style={{ width: 42, height: 42, borderRadius: 13, background: a.soft, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Ico size={24} color={a.color} strokeWidth={2} />
                  </div>
                  <span style={{ fontFamily: fonts.display, fontWeight: 600, fontSize: 27, color: c.ink }}>{a.label}</span>
                </div>
              </Appear>
            );
          })}
        </div>

        <RiseIn delay={Math.round(dur * 0.5)} style={{ marginTop: 52 }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 16,
              padding: "20px 40px",
              borderRadius: radius.chip,
              background: c.coral,
              boxShadow: shadow.lift,
            }}
          >
            <Link size={28} color={c.white} strokeWidth={2.4} />
            <span style={{ fontFamily: fonts.mono, fontWeight: 500, fontSize: 34, color: c.white, letterSpacing: 0.5 }}>{url}</span>
          </div>
        </RiseIn>
      </div>
    </SceneLayout>
  );
};
