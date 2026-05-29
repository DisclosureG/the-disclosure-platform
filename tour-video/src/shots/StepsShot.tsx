import React from "react";
import { c } from "../theme";
import { fonts } from "../fonts";
import { SceneLayout } from "../components/SceneLayout";
import { SceneHeader } from "../components/SceneHeader";
import { Card, Appear, IconBubble } from "../components/ui";
import { IconByName, type IconName } from "../components/Icons";

export type StepsShotProps = {
  kicker: string;
  headline: string;
  items: Array<{
    ordinal: string;
    title: string;
    sub: string;
    icon: IconName;
    color: string;
    soft: string;
  }>;
};

export const StepsShot: React.FC<StepsShotProps> = ({ kicker, headline, items }) => (
  <SceneLayout align="top" padY={92}>
    <SceneHeader kicker={kicker} headline={headline} marginBottom={56} />
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 30,
        width: "100%",
        maxWidth: 1480,
      }}
    >
      {items.map((it, i) => {
        const Ico = IconByName[it.icon];
        return (
          <Appear key={i} delay={14 + i * 9} origin="center bottom">
            <Card pad={34} style={{ display: "flex", alignItems: "center", gap: 28 }}>
              <IconBubble bg={it.soft} size={92}>
                <Ico size={46} color={it.color} strokeWidth={1.8} />
              </IconBubble>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                <div
                  style={{
                    fontFamily: fonts.body,
                    fontWeight: 700,
                    fontSize: 18,
                    letterSpacing: 2.5,
                    color: it.color,
                  }}
                >
                  {it.ordinal}
                </div>
                <div style={{ fontFamily: fonts.display, fontWeight: 600, fontSize: 33, color: c.ink, lineHeight: 1.05 }}>
                  {it.title}
                </div>
                <div style={{ fontFamily: fonts.body, fontWeight: 400, fontSize: 22, color: c.inkSoft, lineHeight: 1.4 }}>
                  {it.sub}
                </div>
              </div>
            </Card>
          </Appear>
        );
      })}
    </div>
  </SceneLayout>
);
