import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { c, radius, shadow } from "../theme";
import { fonts } from "../fonts";
import { SceneLayout } from "../components/SceneLayout";
import { SceneHeader } from "../components/SceneHeader";
import { Appear, RiseIn, IconBubble } from "../components/ui";
import { MetaMaskFox } from "../components/MetaMaskFox";
import { IconByName, type IconName } from "../components/Icons";
import { floatY } from "../anim";

// "Why a wallet?" — a plain-language reassurance beat for non-crypto viewers.
// A hero card: the official MetaMask fox on the left, three friendly points on
// the right. Keeps the Daylight register — warm card, butter bubble around the
// fox so its official orange sits in the palette, soft staggered entrances.
export type WalletShotProps = {
  kicker: string;
  headline: string;
  brandName: string;
  brandSub: string;
  lead: string;
  points: Array<{ icon: IconName; title: string; sub: string; color: string; soft: string }>;
};

export const WalletShot: React.FC<WalletShotProps> = ({
  kicker,
  headline,
  brandName,
  brandSub,
  lead,
  points,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames: dur } = useVideoConfig();
  const bob = floatY(frame, 7, 150);

  return (
    <SceneLayout align="top" padY={94}>
      <SceneHeader
        kicker={kicker}
        headline={headline}
        size={58}
        marginBottom={48}
        kickerColor="#B8801F"
        kickerSoft={c.butterSoft}
      />

      <Appear delay={Math.round(dur * 0.04)} origin="center top">
        <div
          style={{
            width: 1240,
            display: "flex",
            alignItems: "center",
            gap: 56,
            background: c.card,
            borderRadius: radius.card,
            boxShadow: shadow.lift,
            padding: "52px 56px",
          }}
        >
          {/* hero: the official MetaMask fox */}
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, flexShrink: 0, width: 360 }}>
            <div style={{ transform: `translateY(${bob}px)` }}>
              <IconBubble bg={c.butterSoft} size={228} style={{ boxShadow: shadow.soft }}>
                <MetaMaskFox size={138} />
              </IconBubble>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <span style={{ fontFamily: fonts.display, fontWeight: 700, fontSize: 34, color: c.ink }}>{brandName}</span>
              <span style={{ fontFamily: fonts.body, fontWeight: 600, fontSize: 19, letterSpacing: 1.6, textTransform: "uppercase", color: c.inkDim }}>
                {brandSub}
              </span>
            </div>
          </div>

          {/* plain-language reassurance */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 22 }}>
            <RiseIn delay={Math.round(dur * 0.1)} distance={18}>
              <span style={{ fontFamily: fonts.display, fontWeight: 500, fontSize: 28, color: c.inkSoft, lineHeight: 1.32 }}>
                {lead}
              </span>
            </RiseIn>

            <div style={{ height: 2, background: c.lineSoft }} />

            {points.map((p, i) => {
              const Ico = IconByName[p.icon];
              return (
                <RiseIn key={i} delay={Math.round(dur * (0.24 + i * 0.16))} distance={20}>
                  <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
                    <IconBubble bg={p.soft} size={66}>
                      <Ico size={34} color={p.color} strokeWidth={1.9} />
                    </IconBubble>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      <span style={{ fontFamily: fonts.display, fontWeight: 600, fontSize: 28, color: c.ink, lineHeight: 1.1 }}>
                        {p.title}
                      </span>
                      <span style={{ fontFamily: fonts.body, fontWeight: 400, fontSize: 21, color: c.inkSoft, lineHeight: 1.35 }}>
                        {p.sub}
                      </span>
                    </div>
                  </div>
                </RiseIn>
              );
            })}
          </div>
        </div>
      </Appear>
    </SceneLayout>
  );
};
