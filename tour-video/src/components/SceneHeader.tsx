import React from "react";
import { c } from "../theme";
import { Kicker, Appear } from "./ui";
import { Headline } from "./Headline";

// Top-of-scene header shared by the content scenes: a kicker pill + a medium
// display headline, centered.
export const SceneHeader: React.FC<{
  kicker: string;
  headline: string;
  accent?: string;
  kickerColor?: string;
  kickerSoft?: string;
  size?: number;
  delay?: number;
  maxWidth?: number | string;
  marginBottom?: number;
}> = ({
  kicker,
  headline,
  accent = c.coral,
  kickerColor,
  kickerSoft,
  size = 62,
  delay = 0,
  maxWidth = 1480,
  marginBottom = 58,
}) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: 26,
      textAlign: "center",
      marginBottom,
    }}
  >
    <Appear delay={delay}>
      <Kicker color={kickerColor} soft={kickerSoft}>
        {kicker}
      </Kicker>
    </Appear>
    <Headline text={headline} size={size} accent={accent} delay={delay + 4} maxWidth={maxWidth} />
  </div>
);
