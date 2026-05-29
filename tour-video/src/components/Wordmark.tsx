import React from "react";
import { c, shadow } from "../theme";
import { fonts } from "../fonts";
import { DMark } from "./DMark";

// Modern, simple brand lockup: a soft coral rounded-square sigil holding a
// white capital "D" monogram (for Disclosure), beside the wordmark.
export const Wordmark: React.FC<{ scale?: number; tag?: boolean; style?: React.CSSProperties }> = ({
  scale = 1,
  tag = true,
  style,
}) => {
  const s = (n: number) => n * scale;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: s(20), ...style }}>
      <div
        style={{
          width: s(74),
          height: s(74),
          borderRadius: s(22),
          background: c.coral,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: shadow.chip,
        }}
      >
        <DMark size={s(58)} color={c.white} />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: s(4) }}>
        <div
          style={{
            fontFamily: fonts.display,
            fontWeight: 600,
            fontSize: s(38),
            color: c.ink,
            letterSpacing: -0.5,
            lineHeight: 1,
          }}
        >
          The Disclosure Platform
        </div>
        {tag ? (
          <div
            style={{
              fontFamily: fonts.body,
              fontWeight: 600,
              fontSize: s(15.5),
              color: c.inkDim,
              letterSpacing: s(3),
              textTransform: "uppercase",
            }}
          >
            DeSci · Evidence Network
          </div>
        ) : null}
      </div>
    </div>
  );
};
