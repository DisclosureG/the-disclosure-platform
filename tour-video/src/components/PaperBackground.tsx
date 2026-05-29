import React from "react";
import { AbsoluteFill } from "remotion";
import { c } from "../theme";
import { FloatingShapes } from "./FloatingShapes";

// The continuous warm "paper" canvas: a soft top-lit gradient, two very faint
// color blooms for warmth, and the drifting shapes field. Rendered once for
// the whole video so scene cuts feel like one continuous, sunny room.
export const PaperBackground: React.FC = () => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(125% 95% at 50% 8%, ${c.paperTop} 0%, ${c.paper} 48%, ${c.paperDeep} 100%)`,
    }}
  >
    {/* faint warm blooms */}
    <div
      style={{
        position: "absolute",
        left: "-12%",
        top: "-16%",
        width: 900,
        height: 900,
        borderRadius: "50%",
        background: c.coral,
        opacity: 0.07,
        filter: "blur(120px)",
      }}
    />
    <div
      style={{
        position: "absolute",
        right: "-14%",
        bottom: "-18%",
        width: 1000,
        height: 1000,
        borderRadius: "50%",
        background: c.sky,
        opacity: 0.08,
        filter: "blur(130px)",
      }}
    />
    <FloatingShapes />
  </AbsoluteFill>
);
