import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { c } from "../theme";
import { fonts } from "../fonts";
import { enter, SPRING } from "../anim";

// Big friendly display headline with a gentle word-by-word rise. Use '\n' for
// line breaks and wrap a word in *asterisks* to paint it coral.
export const Headline: React.FC<{
  text: string;
  size?: number;
  color?: string;
  accent?: string;
  weight?: number;
  lineHeight?: number;
  align?: "center" | "left";
  delay?: number;
  stride?: number;
  maxWidth?: number | string;
  style?: React.CSSProperties;
}> = ({
  text,
  size = 92,
  color = c.ink,
  accent = c.coral,
  weight = 700,
  lineHeight = 1.05,
  align = "center",
  delay = 0,
  stride = 2.1,
  maxWidth,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const lines = text.split("\n");
  let wordIdx = 0;

  return (
    <div
      style={{
        fontFamily: fonts.display,
        fontWeight: weight,
        fontSize: size,
        lineHeight,
        color,
        textAlign: align,
        letterSpacing: size > 60 ? -1.2 : -0.4,
        maxWidth,
        ...style,
      }}
    >
      {lines.map((line, li) => {
        // Tokenize on '*' so a multi-word *accent phrase* is detected, not just
        // single wrapped words. Odd split segments are the accented runs.
        const tokens: Array<{ word: string; acc: boolean }> = [];
        line.split("*").forEach((part, pi) => {
          const acc = pi % 2 === 1;
          part.split(" ").forEach((w) => {
            if (w.length) tokens.push({ word: w, acc });
          });
        });
        return (
          <div key={li} style={{ display: "block" }}>
            {tokens.map((tok, wi) => {
              const d = delay + wordIdx * stride;
              wordIdx += 1;
              const s = enter(frame, fps, d, SPRING.soft);
              const ty = interpolate(s, [0, 1], [26, 0]);
              const op = interpolate(frame - d, [0, 9], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              });
              return (
                <span
                  key={wi}
                  style={{
                    display: "inline-block",
                    transform: `translateY(${ty}px)`,
                    opacity: op,
                    color: tok.acc ? accent : undefined,
                    marginRight: "0.27em",
                    whiteSpace: "pre",
                  }}
                >
                  {tok.word}
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};
