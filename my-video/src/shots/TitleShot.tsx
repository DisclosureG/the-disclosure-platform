import React from "react";
import { c } from "../theme";
import { fonts } from "../fonts";
import { SceneLayout } from "../components/SceneLayout";
import { Kicker, Appear, RiseIn, IconBubble } from "../components/ui";
import { Headline } from "../components/Headline";
import { Wordmark } from "../components/Wordmark";
import { Scale, Compass, Heart } from "../components/Icons";

export type TitleShotProps = {
  kicker: string;
  headline: string;
  subhead?: string;
  brand?: boolean;
  icon?: "scale" | "compass" | "heart";
  iconColor?: string;
  iconBg?: string;
  headlineSize?: number;
};

const ICONS = { scale: Scale, compass: Compass, heart: Heart };

export const TitleShot: React.FC<TitleShotProps> = ({
  kicker,
  headline,
  subhead,
  brand,
  icon,
  iconColor = c.coralDeep,
  iconBg = c.coralSoft,
  headlineSize = 96,
}) => {
  const Ico = icon ? ICONS[icon] : null;
  return (
    <SceneLayout>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        {brand ? (
          <Appear delay={2} style={{ marginBottom: 52 }}>
            <Wordmark />
          </Appear>
        ) : null}

        {Ico ? (
          <Appear delay={3} style={{ marginBottom: 38 }}>
            <IconBubble bg={iconBg} size={104}>
              <Ico size={50} color={iconColor} strokeWidth={1.8} />
            </IconBubble>
          </Appear>
        ) : null}

        <Appear delay={brand ? 8 : 4} style={{ marginBottom: 32 }}>
          <Kicker>{kicker}</Kicker>
        </Appear>

        <Headline text={headline} size={headlineSize} delay={brand ? 13 : 9} maxWidth={1500} />

        {subhead ? (
          <RiseIn delay={26} style={{ marginTop: 40 }}>
            <div
              style={{
                fontFamily: fonts.body,
                fontWeight: 400,
                fontSize: 31,
                lineHeight: 1.5,
                color: c.inkSoft,
                textAlign: "center",
                maxWidth: 1040,
              }}
            >
              {subhead}
            </div>
          </RiseIn>
        ) : null}
      </div>
    </SceneLayout>
  );
};
