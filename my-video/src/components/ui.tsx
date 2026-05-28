import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { c, radius, shadow } from "../theme";
import { fonts } from "../fonts";
import { pop, rise, SPRING } from "../anim";

// --- entrance wrappers ------------------------------------------------------
export const Appear: React.FC<{
  delay?: number;
  config?: { damping: number; mass?: number; stiffness?: number };
  origin?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ delay = 0, config = SPRING.bounce, origin = "center", children, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { scale, opacity } = pop(frame, fps, delay, config);
  return (
    <div style={{ transform: `scale(${scale})`, transformOrigin: origin, opacity, ...style }}>
      {children}
    </div>
  );
};

export const RiseIn: React.FC<{
  delay?: number;
  distance?: number;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ delay = 0, distance = 34, children, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { translateY, opacity } = rise(frame, fps, delay, distance);
  return <div style={{ transform: `translateY(${translateY}px)`, opacity, ...style }}>{children}</div>;
};

// --- atoms ------------------------------------------------------------------
export const Kicker: React.FC<{
  children: React.ReactNode;
  color?: string;
  soft?: string;
  style?: React.CSSProperties;
}> = ({ children, color = c.coralDeep, soft = c.coralSoft, style }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 11,
      padding: "11px 22px 11px 20px",
      borderRadius: radius.chip,
      background: soft,
      color,
      fontFamily: fonts.body,
      fontWeight: 600,
      fontSize: 21,
      letterSpacing: 1.4,
      textTransform: "uppercase",
      ...style,
    }}
  >
    <span style={{ width: 9, height: 9, borderRadius: "50%", background: color, display: "inline-block" }} />
    {children}
  </div>
);

export const IconBubble: React.FC<{
  children: React.ReactNode;
  bg: string;
  size?: number;
  style?: React.CSSProperties;
}> = ({ children, bg, size = 76, style }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: "30%",
      background: bg,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
      ...style,
    }}
  >
    {children}
  </div>
);

export const Card: React.FC<{
  children: React.ReactNode;
  pad?: number | string;
  radiusPx?: number;
  bg?: string;
  elevation?: keyof typeof shadow;
  style?: React.CSSProperties;
}> = ({ children, pad = 34, radiusPx = radius.card, bg = c.card, elevation = "card", style }) => (
  <div
    style={{
      background: bg,
      borderRadius: radiusPx,
      boxShadow: shadow[elevation],
      padding: pad,
      ...style,
    }}
  >
    {children}
  </div>
);

export const Chip: React.FC<{
  children: React.ReactNode;
  icon?: React.ReactNode;
  bg?: string;
  color?: string;
  style?: React.CSSProperties;
}> = ({ children, icon, bg = c.card, color = c.ink, style }) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 12,
      padding: icon ? "15px 26px 15px 20px" : "15px 28px",
      borderRadius: radius.chip,
      background: bg,
      color,
      boxShadow: shadow.chip,
      fontFamily: fonts.display,
      fontWeight: 600,
      fontSize: 27,
      ...style,
    }}
  >
    {icon}
    {children}
  </div>
);

export const Badge: React.FC<{
  children: React.ReactNode;
  color: string;
  soft: string;
  style?: React.CSSProperties;
}> = ({ children, color, soft, style }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      padding: "7px 15px",
      borderRadius: radius.chip,
      background: soft,
      color,
      fontFamily: fonts.body,
      fontWeight: 700,
      fontSize: 17,
      letterSpacing: 1,
      textTransform: "uppercase",
      ...style,
    }}
  >
    {children}
  </span>
);

export const Dot: React.FC<{ color: string; size?: number; style?: React.CSSProperties }> = ({
  color,
  size = 12,
  style,
}) => <span style={{ width: size, height: size, borderRadius: "50%", background: color, display: "inline-block", flexShrink: 0, ...style }} />;
